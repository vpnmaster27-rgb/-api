// Membership is frozen for a round. New eligible accounts enter the next round.
export function remainingMembers(state, accounts) {
  const eligible = new Set(accounts.map(String));
  if (!state.members) Object.assign(state, { round: 1, members: [...eligible], used: [] });
  let remaining = state.members.filter(id => eligible.has(id) && !state.used.includes(id));
  if (!remaining.length && eligible.size) {
    Object.assign(state, { round: state.round + 1, members: [...eligible], used: [] });
    remaining = [...eligible];
  }
  return remaining;
}

export function chooseRotation(state, people, daily, hours, random = Math.random) {
  const remaining = new Set(remainingMembers(state, people.map(p => p.account)));
  let candidates = people.filter(p => remaining.has(String(p.account)));
  const unusedToday = candidates.filter(p => !daily.has(String(p.account)));
  if (unusedToday.length) candidates = unusedToday;
  candidates = candidates.map(person => ({ person, tie: random() })).sort((a, b) =>
    (hours.get(String(a.person.account)) || 0) - (hours.get(String(b.person.account)) || 0)
    || (daily.get(String(a.person.account)) || 0) - (daily.get(String(b.person.account)) || 0)
    || a.tie - b.tie);
  if (!candidates.length) return null;
  const person = candidates[0].person;
  state.used.push(String(person.account));
  return person;
}

export function rotationKey(task) {
  if (task.automationRuleId !== 'maintenance-45-items') return null;
  // Title identifies the same recurring job across years; property scopes its roster.
  return JSON.stringify([task.propertyId || '', String(task.title || '').normalize('NFKC').trim()]);
}
