// Shared by the booking screen and the Render correction API.
(function (root, makeSchedule) {
  if (typeof module === 'object' && module.exports) module.exports = makeSchedule(require('./booking-correction'));
  else root.TherapistSchedule = makeSchedule(root.BookingCorrection);
})(globalThis, function (booking) {
  'use strict';
  const roster = [
    {id:'T_GUO', name:'郭老師', specialty:'整復推拿', exp:'', avatar:'郭', role:'boss'},
    {id:'T_HON', name:'洪老師', specialty:'整復推拿', exp:'', avatar:'洪', role:'boss'},
    {id:'T043', name:'43號', specialty:'整復推拿', exp:'', avatar:'43', role:'staff'},
    {id:'T031', name:'31號', specialty:'整復推拿', exp:'', avatar:'31', role:'staff'},
    {id:'T026', name:'26號', specialty:'整復推拿', exp:'', avatar:'26', role:'staff'},
    {id:'T007', name:'7號', specialty:'整復推拿', exp:'', avatar:'7', role:'staff'}
  ];
  const dayMs = 86400000;
  const taipeiOffset = 8 * 3600000;
  function windowFor(row) {
    if (!row || !['accepted', 'new'].includes(row.status)) return null;
    let start = row.startTime && Number(row.startTimestamp);
    if (!(start > 0)) {
      const day = row.startDateKey || booking.dateKey(row);
      const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(row.startTime || row.time || '');
      if (!day || !clock) return null;
      start = Date.parse(day + 'T00:00:00+08:00') +
        (+clock[1] * 60 + +clock[2]) * 60000 + Number(clock[3] || 0) * 1000;
    }
    const end = start + (booking.bookingMinutes(row) + Number(row.extraMins || 0)) * 60000;
    return Number.isFinite(end) && end > start ? {start, end} : null;
  }
  function staffIds(row, employeeFor) {
    let primary = row.therapistId;
    if ((!primary || primary === 'none') && row.acceptedBy) {
      const employee = employeeFor(row.acceptedBy) || {};
      const known = roster.find(t => t.id === row.acceptedBy || t.name === employee.name);
      primary = employee.therapistId || known?.id || 'employee:' + row.acceptedBy;
    }
    return [primary, row.supportId].filter(id => id && id !== 'none');
  }
  function overlapping(candidate, rows) {
    const requested = windowFor(candidate);
    if (!requested) return [];
    return rows.filter(row => {
      if (candidate.id && row.id === candidate.id) return false;
      const other = windowFor(row);
      return other && requested.start < other.end && other.start < requested.end;
    });
  }
  function conflicts(candidate, rows, employeeFor) {
    const ids = staffIds(candidate, employeeFor);
    return ids.length > 0 && overlapping(candidate, rows).some(row =>
      staffIds(row, employeeFor).some(id => ids.includes(id)));
  }
  // Every allocation on a business day reads and changes the same revision in its
  // booking transaction. Concurrent browser submissions retry with a fresh server query.
  async function guard(current, next, store) {
    const slot = windowFor(next);
    if (!slot || !staffIds(next, () => null).length) return;
    const old = windowFor(current);
    if (old && current.status === next.status && current.therapistId === next.therapistId &&
        current.acceptedBy === next.acceptedBy && current.supportId === next.supportId &&
        current.startTime === next.startTime && old.start === slot.start && slot.end <= old.end && current.bed === next.bed) return;

    const locks = [];
    const first = Math.floor((slot.start + taipeiOffset) / dayMs);
    const last = Math.floor((slot.end - 1 + taipeiOffset) / dayMs);
    for (let day = first; day <= last; day++) {
      const key = 'staff_' + new Date(day * dayMs).toISOString().slice(0, 10);
      locks.push([key, await store.revision(key)]);
    }
    const rows = overlapping(next, await store.openBookings());
    const employees = new Map();
    for (const row of [next, ...rows]) {
      if ((!row.therapistId || row.therapistId === 'none') && row.acceptedBy && !employees.has(row.acceptedBy)) {
        employees.set(row.acceptedBy, await store.employee(row.acceptedBy));
      }
    }
    if (conflicts(next, rows, id => employees.get(id))) {
      const message = '師傅在這段時間已有預約，請改選其他師傅或時段。';
      throw Object.assign(new Error('THERAPIST_CONFLICT'), {code:'therapist-conflict', status:409, publicMessage:message});
    }
    for (const [key, revision] of locks) store.bump(key, revision + 1);
  }
  return {roster, windowFor, conflicts, guard};
});
