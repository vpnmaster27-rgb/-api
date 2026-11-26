import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseRotation, rotationKey } from '../src/taskRotation.js';
import { rotateScheduledTasks } from '../src/rotationDispatch.js';
import { refreshRosterAssignments } from '../src/rosterRotationWatch.js';

const people = ['A','B','C','D'].map((username,i) => ({ id:i+1,account:i+1,username }));
const choose = (state, staff=people, daily=new Map()) => chooseRotation(state,staff,daily,new Map(),()=>0);

test('same task must exhaust A B C D before repeating; each task has independent rounds', () => {
  const state = {};
  assert.deepEqual(Array.from({length:8},()=>choose(state).username),['A','B','C','D','A','B','C','D']);
  assert.equal(state.round,2);
  assert.equal(choose({}).username,'A');
  assert.notEqual(rotationKey({automationRuleId:'maintenance-45-items',title:'water'}),rotationKey({automationRuleId:'maintenance-45-items',title:'lift'}));
});
test('new employee enters next round, removed employees do not block rounds', () => {
  const state = {};
  assert.equal(choose(state).username,'A');
  const added=[...people,{id:5,account:5,username:'E'}];
  assert.deepEqual(Array.from({length:3},()=>choose(state,added).username),['B','C','D']);
  const next=Array.from({length:5},()=>choose(state,added).username);
  assert.deepEqual(new Set(next),new Set(['A','B','C','D','E']));
  const removed={round:1,members:['1','2'],used:['1']};
  assert.equal(choose(removed,[people[0]]).username,'A');
  assert.equal(removed.round,2);
});
test('daily uniqueness is preferred, strict per-task round takes precedence', () => {
  assert.equal(choose({},people,new Map([['1',1]])).username,'B');
  assert.equal(choose({round:1,members:['1','2'],used:['2']},people,new Map([['1',1]])).username,'A');
});

function fakeDatabase() {
  const tasks=new Map(), states=new Map(), logs=new Map();
  return {tasks,states,logs,people:structuredClone(people),async query(sql,v=[]) {
    if(sql.startsWith('SELECT id, account'))return structuredClone(this.people);
    if(sql.startsWith('SELECT state FROM'))return states.has(v[0]) ? [{state:structuredClone(states.get(v[0]))}] : [];
    if(sql.startsWith('SELECT id, payload'))return [...tasks].map(([id,payload])=>({id,payload:JSON.stringify(payload)}));
    if(sql.startsWith('SELECT task_key'))return [...states].map(([task_key,state])=>({task_key,state:structuredClone(state)}));
    if(sql.startsWith('SELECT work_order_id'))return [...logs].map(([work_order_id,assignment])=>({work_order_id,assignment:structuredClone(assignment)}));
    if(sql.startsWith('INSERT INTO public.task_auto_assignments')) {if(!logs.has(v[0]))logs.set(v[0],JSON.parse(v[2]));return [];}
    if(sql.startsWith('INSERT INTO public.task_rotation_states')) {states.set(v[0],JSON.parse(v[1]));return [];}
    if(sql.startsWith('UPDATE public.work_orders')) {tasks.set(v[2],JSON.parse(v[0]));return [];}
    throw Error(sql);
  }};
}
test('dispatch history persists across dates; transfer and reruns never consume extra turns; previews do not consume', async () => {
  const db=fakeDatabase();
  for(let d=1;d<=8;d++)db.tasks.set(`job-${d}`,{id:`job-${d}`,title:'water',propertyId:'p7',automationRuleId:'maintenance-45-items',hours:1,startAt:Date.parse(`2026-12-0${d}T09:00:00+08:00`),status:'pending'});
  await rotateScheduledTasks(db,'2026-12-01',false);
  assert.equal(db.logs.size,0);
  assert.equal([...db.states.values()][0]?.used.length || 0,0);
  const recipients=[];
  for(let d=1;d<=8;d++) {
    await rotateScheduledTasks(db,`2026-12-0${d}`,true);
    const task=db.tasks.get(`job-${d}`),record=db.logs.get(task.id);
    recipients.push(record.account);
    assert.equal(record.account,task.assignedAccount);
    task.assignedTo='manual-transferee';task.transferredAt=Date.now();
    await rotateScheduledTasks(db,`2026-12-0${d}`,true);
    assert.equal(db.logs.size,d);
    assert.equal(db.logs.get(task.id).account,record.account);
    assert.equal(db.tasks.get(task.id).assignedTo,'manual-transferee');
  }
  assert.equal(new Set(recipients.slice(0,4)).size,4);
  assert.equal(new Set(recipients.slice(4,8)).size,4);
});
test('legacy transfer seeds original automation recipient rather than transferee', async () => {
  const db=fakeDatabase();db.tasks.set('old',{id:'old',title:'water',automationRuleId:'maintenance-45-items',startAt:Date.parse('2026-11-01T09:00:00+08:00'),assignedTo:'B',technicianId:2,assignedBy:'manager',timeline:[{text:'依自動化規則排程，指派給一般機電：A'}]});
  await rotateScheduledTasks(db,'2026-12-01',true);
  assert.equal(db.logs.get('old').account,1);
});

test('absent D still completes the round and leaves an unassigned supervisor task', async () => {
  const db=fakeDatabase();
  const template={title:'water',propertyId:'p7',automationRuleId:'maintenance-45-items',hours:1,status:'pending'};
  const key=rotationKey(template);
  db.states.set(key,{round:1,members:['1','2','3','4'],used:['1','2','3']});
  db.tasks.set('D-job',{...template,id:'D-job',startAt:Date.parse('2030-01-01T09:00:00+08:00')});
  await rotateScheduledTasks(db,'2030-01-01',true,async()=>false);
  const task=db.tasks.get('D-job');
  assert.equal(task.mobileStatus,'unassigned');
  assert.equal(task.technicianId,null);
  assert.equal(task.autoAssignment.account,4);
  assert.equal(db.logs.get('D-job').account,4);
  assert.deepEqual(db.states.get(key).used,['1','2','3','4']);
  task.assignedTo='A';task.assignedBy='manager';task.transferredAt=1;
  await rotateScheduledTasks(db,'2030-01-01',true,async()=>false);
  assert.equal(db.tasks.get('D-job').assignedTo,'A');
  assert.equal(db.logs.get('D-job').account,4);
  assert.equal(db.logs.size,1);
});

test('DB newcomer triggers preview rebuild for every job; each current round remains frozen', async () => {
  const db=fakeDatabase();
  for(const title of ['water','lift'])for(let day=1;day<=10;day++) {
    const id=`${title}-${day}`;
    db.tasks.set(id,{id,title,propertyId:'p7',automationRuleId:'maintenance-45-items',hours:1,status:'pending',startAt:Date.UTC(2030,0,day,1)});
  }
  const transaction=work=>work(db);
  assert.equal(await refreshRosterAssignments(transaction),true);
  assert.equal(await refreshRosterAssignments(transaction),false);
  db.people.push({id:5,account:5,username:'E'});
  assert.equal(await refreshRosterAssignments(transaction),true);
  for(const title of ['water','lift']) {
    const plans=[...db.tasks.values()].filter(t=>t.title===title).map(t=>t.autoAssignment);
    assert.equal(plans.filter(a=>a.round===1).length,4);
    assert.ok(plans.filter(a=>a.round===1).every(a=>a.account!==5));
    assert.deepEqual(new Set(plans.filter(a=>a.round===2).map(a=>a.account)),new Set([1,2,3,4,5]));
  }
  assert.equal(db.logs.size,0);
  assert.equal(await refreshRosterAssignments(transaction),false);
});
