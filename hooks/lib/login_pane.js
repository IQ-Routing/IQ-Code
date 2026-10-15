export const ACTIVATION_URL = 'https://iq-routing.com/iq-code/activate'

export const LOGIN_CONSENT = [
  "Connect IQ Code. On Personal, Team or Enterprise, this turns routing on for this session. With routing on, IQ receives the prompt as submitted, including pasted text, and recent submitted prompts after a best-effort scrub and removal of known host context, plus scrubbed subagent briefs. Your model tokens still go straight to Anthropic on your plan.",
  "Connecting also turns on Keep routing on for future interactive sessions on this device. It stays on until you use `/iq-route off`, turn off Keep routing on in `/iq Settings`, or use `/iq logout`. Kill switches and plan restrictions still apply. Free connections do not enable IQ Code routing; it requires Personal or higher.",
  "On a paid IQ plan, IQ Code sends measured usage numbers (token counts, API-equivalent cost and model) to IQ while routing is on. Usage reports never include prompts, answers, files or other content. Usage reporting defaults on for paid plans; turn it off on this device in `/iq Settings`. An existing off setting stays off.",
  "Your IQ Code login key lasts 90 days, then you must reconnect. Approve only if you started `/iq login` on your own device.",
]
export const LOGIN_SUCCESS = {
  paid: "Connected to IQ Code. Routing is on for this session and will start on in future interactive sessions on this device; kill switches still apply.",
  free: "Connected to IQ Code. Keep routing on is saved for this device. IQ Code routing requires Personal or higher. Routing is off.",
  blocked: "Connected to IQ Code. Keep routing on is saved for this device. Routing is off because a routing control or plan restriction is active.",
}
export const authCommandMatches = (args) => typeof args === 'string' && /^\s*(?:login(?:\s+(?:status|cancel))?|logout)\s*$/i.test(args)

const MESSAGES = {
  idle: 'Use /iq login to connect.', starting: 'Starting a connection…', pending: 'Waiting for approval in your browser.',
  saving: 'Saving the connection…', confirming: 'Confirming delivery…',
  cancelled: 'Connection cancelled.', ended: 'Connection ended.', logged_out: 'Disconnected on this device.',
  disconnected: 'Disconnected on this device.',
  disabled: 'Browser login is unavailable in this build. You can still configure an IQ key manually.',
}
const ERRORS = {
  traffic_disabled: 'IQ traffic is blocked by a control on this device.', access_denied: 'Connection denied in the browser.',
  expired_token: 'This connection expired. Run /iq login again.', invalid_grant: 'This connection is no longer available. Run /iq login again.',
  save_failed: 'Could not save the connection. Routing remains off.', complete_failed: 'Could not confirm delivery. Routing remains off.',
  persistence_failed: 'Could not persist logout. Use a global IQ traffic kill switch and revoke the key in the dashboard before restarting.',
  feature_disabled: 'Browser login is unavailable in this build. Add an IQ key with /plugin configure iq-code@iq-routing, then /reload-plugins.',
  traffic_blocked: 'IQ traffic is blocked by a control on this device.',
  settings_save_failed: 'Could not save routing consent. Routing remains off.',
  configure_failed: 'Could not save the connection. Routing remains off.',
  cli_missing: 'Claude Code configuration is unavailable here. Configure an IQ key manually, then /reload-plugins.',
  confirmation_failed: 'Could not confirm delivery. Routing remains off.',
  logout_persistence_failed: 'Could not persist logout. Use a global IQ traffic kill switch and revoke the key in the dashboard before restarting.',
  login_persistence_failed: 'Connection failed and could not be blocked persistently. Only this session is guaranteed off. Use a global IQ traffic kill switch and dashboard revocation before restarting.',
}

export function loginPane(E, state, cancel) {
  const { Box, Text, Link, Button } = E
  const s = state || { phase: 'idle' }
  const showConsent = s.code !== 'feature_disabled' && !['idle', 'disconnected'].includes(s.phase)
  const children = [Text({ bold: true, children: 'IQ connection' }), ...(showConsent ? LOGIN_CONSENT.map((text) => Text({ children: text })) : [])]
  children.push(Text({ children: ERRORS[s.code] || (s.phase === 'connected' ? LOGIN_SUCCESS[s.code] || LOGIN_SUCCESS.blocked : MESSAGES[s.phase]) || 'Connection unavailable. Run /iq login again.' }))
  if (s.userCode) {
    children.push(Text({ bold: true, children: s.userCode }))
    children.push(Text({ children: 'Open the link, enter this code, compare it with this pane, then choose Approve in the browser.' }))
    children.push(Link ? Link({ href: ACTIVATION_URL, label: ACTIVATION_URL }) : Text({ children: ACTIVATION_URL }))
  }
  if (s.keyExpiresAt) children.push(Text({ children: 'Key expires: ' + s.keyExpiresAt + '. Reconnect then; there is no automatic renewal.' }))
  if (s.localOnly || s.code === 'logout_local_only') children.push(Text({ children: 'Local logout is complete. Server revocation was not confirmed. Revoke browser-issued keys in the IQ dashboard; pasted/shared keys are only disconnected here.' }))
  if (['starting', 'pending', 'saving', 'confirming'].includes(s.phase)) children.push(Button({ key: 'cancel-login', label: 'Cancel', onPress: cancel }))
  return Box({ flexDirection: 'column', rowGap: 1, children })
}
