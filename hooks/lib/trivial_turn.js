


export const INJECTED_TAGS = Object.freeze([
  'system-reminder', 'command-name', 'command-message', 'command-args',
  'local-command-stdout', 'local-command-stderr', 'local-command-caveat',
  'bash-input', 'bash-stdout', 'bash-stderr', 'user-prompt-submit-hook',
  'ide_selection', 'ide_opened_file', 'new-context', 'unknown-block',
  'launch-selected-element', 'preview-annotation-context', 'artifact-view-context',
  'environment_context', 'task-notification', 'teammate-message',
])
const ENVELOPES = new Set(INJECTED_TAGS)
const SUBAGENT_TASK_TAGS = new Set(['teammate-message'])
const SUBAGENT_CONTEXT_TAGS = INJECTED_TAGS.filter(tag => !SUBAGENT_TASK_TAGS.has(tag))
const ACK = /^(?:ok|okay|k|ok thanks|okay thanks|yes|yep|no|nope|sure|got it|sounds good|thanks|thank you|continue|go on|proceed|carry on)[.!]?$/i

export function turnText(text) {
  if (typeof text !== 'string') return null
  let rest = text.trim()

  while (rest.startsWith('<')) {
    const block = /^<([\w-]+)(?:\s[^<>]*)?>[\s\S]*?<\/\1\s*>/.exec(rest)
    if (!block || !ENVELOPES.has(block[1].toLowerCase())) break
    rest = rest.slice(block[0].length).trim()
  }
  return rest.replace(/<\/?pasted_content(?=[\s/>])[^>]{0,256}>/gi, '').trim()
}

export function trivialTurn(text) {
  const rest = turnText(text)
  return rest !== null && (rest === '' || ACK.test(rest))
}



export function subagentBriefText(text) {
  if (typeof text !== 'string') return null
  let rest = withoutInjectedBlocks(text, SUBAGENT_CONTEXT_TAGS).trim()
  while (rest.startsWith('<')) {
    const block = /^<([\w-]+)(?:\s[^<>]*)?>([\s\S]*)<\/\1\s*>$/i.exec(rest)
    if (!block || !SUBAGENT_TASK_TAGS.has(block[1].toLowerCase())) break
    let depth = 0, enclosed = true
    const tags = new RegExp('<(/?)' + block[1] + '(?=[\\s/>])[^>]{0,256}>', 'gi')
    for (const tag of rest.matchAll(tags)) {
      if (/\/\s*>$/.test(tag[0])) continue
      depth += tag[1] ? -1 : 1
      if (depth === 0 && tag.index + tag[0].length !== rest.length) { enclosed = false; break }
    }
    if (!enclosed || depth !== 0) break
    rest = block[2].trim()
  }
  return rest
}

export function withoutInjectedBlocks(t, tags = INJECTED_TAGS) {
  if (typeof t !== 'string') return ''
  const pattern = new RegExp('<(/?)(' + tags.join('|') + ')(?=[\\s/>])[^>]{0,256}>', 'gi')
  const stack = []
  let out = '', cursor = 0
  for (const match of t.matchAll(pattern)) {
    if (stack.length === 0) out += t.slice(cursor, match.index)
    const name = match[2].toLowerCase()
    if (match[1]) {
      const at = stack.lastIndexOf(name)
      if (at >= 0) stack.length = at
    } else if (!/\/\s*>$/.test(match[0])) stack.push(name)
    cursor = match.index + match[0].length
  }
  return out + (stack.length === 0 ? t.slice(cursor) : '')
}


export function typedPromptText(t) {
  return withoutInjectedBlocks(t, [...INJECTED_TAGS, 'pasted_content'])
}
