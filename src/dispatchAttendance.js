// Attendance integration is not connected yet. Test mode treats everyone as
// present, matching the existing 24-hour attendance behavior.
export async function isPresentForDispatch(_conn, _account, _dateKey) {
  return true;
}

export function applyAttendanceResult(task, present) {
  if (present || task.transferredAt || task.assignedBy) return task;
  // Preserve autoAssignment: an absent automatic recipient still used a turn.
  return { ...task, technicianId: null, technicianName: '', assignedTo: null,
    assignedToId: null, assignedAccount: null, status: 'pending', mobileStatus: 'unassigned',
    unassignedReason: 'automatic_assignee_absent' };
}
