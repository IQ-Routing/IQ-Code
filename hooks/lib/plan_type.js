
export const PLAN_TYPES = ['auto', 'api', 'subscription']

export function newPlanType() {
  let completed = false
  let rows = []
  let override = 'auto'
  const detected = () => rows.length > 0 ? 'subscription' : completed ? 'api' : 'unknown'
  const view = () => ({ detected: detected(), planType: override === 'auto' ? detected() : override, overridden: override !== 'auto', setting: override })
  return {
    reading(rateLimits) { rows = Array.isArray(rateLimits) ? rateLimits.slice() : []; return view() },
    completed(rateLimits = rows) { completed = true; rows = Array.isArray(rateLimits) ? rateLimits.slice() : []; return view() },
    override(value) { if (PLAN_TYPES.includes(value)) override = value; return view() },
    view,
  }
}
