const STATES = Object.freeze(["PENDING","RUNNING","COMPENSATING","SUCCEEDED","FAILED","CANCELLED"]);
const NEXT = Object.freeze({
  PENDING:["RUNNING","CANCELLED"],
  RUNNING:["RUNNING","COMPENSATING","SUCCEEDED","FAILED","CANCELLED"],
  COMPENSATING:["COMPENSATING","FAILED","CANCELLED"],
  SUCCEEDED:[], FAILED:[], CANCELLED:[]
});

function deepFreeze(value, seen = new WeakSet()) {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
    Object.freeze(value);
  }
  return value;
}

/** Pure state transition helper; it does not execute steps or call external systems. */
export function transitionSaga(saga, nextState, event) {
  if (!saga || !STATES.includes(saga.state) || !NEXT[saga.state].includes(nextState))
    return {ok:false, reason:"INVALID_STATE_TRANSITION"};
  if (!event || typeof event.id !== "string" || typeof event.at !== "string" || !Number.isFinite(Date.parse(event.at)))
    return {ok:false, reason:"INVALID_EVENT"};
  if (!Array.isArray(saga.events) || saga.events.some(e => e.id === event.id))
    return {ok:false, reason:"DUPLICATE_OR_INVALID_EVENT"};
  const events = [
    ...saga.events.map(entry => structuredClone(entry)),
    structuredClone(event)
  ];
  const updated = {
    ...structuredClone(saga),
    state:nextState,
    version:(Number.isInteger(saga.version) ? saga.version : 0)+1,
    updatedAt:event.at,
    events
  };
  return {ok:true, value:deepFreeze(updated)};
}

export function createSaga({id, goal, createdAt}) {
  if (typeof id !== "string" || !id || typeof goal !== "string" || !goal ||
      typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) {
    throw new TypeError("INVALID_SAGA_INPUT");
  }
  return deepFreeze({id, goal, state:"PENDING", version:0, createdAt, updatedAt:createdAt, events:[]});
}

export function sagaStates() { return [...STATES]; }
