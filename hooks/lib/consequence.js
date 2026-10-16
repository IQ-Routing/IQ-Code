
const result = (level, rule) => ({ level, rule })
const READ_TOOLS = new Set(['read', 'grep', 'glob', 'ls', 'webfetch', 'websearch'])
const WRITE_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit'])
const tokens = text => (text.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g) || []).map(x => /^['"]/.test(x) ? x.slice(1, -1) : x)
const base = word => String(word || '').replace(/^.*[\\/]/, '').toLowerCase().replace(/\.exe$/, '')

function segments(text) {
  const parts = []; let part = '', quote = '', escaped = false
  for (const ch of text) {
    if (escaped) { part += ch; escaped = false; continue }
    if (ch === '\\') { part += ch; escaped = true; continue }
    if (quote) { part += ch; if (ch === quote) quote = ''; continue }
    if (ch === '"' || ch === "'") { quote = ch; part += ch; continue }
    if (';&|\n'.includes(ch)) { if (part.trim()) parts.push(part); part = ''; continue }
    part += ch
  }
  if (part.trim()) parts.push(part)
  return parts
}
function command(text, depth = 0) {
  if (depth > 5) return result(1, 'shell_other')
  let best = null
  for (const segment of segments(text.slice(0, 4000))) {
    const r = one(tokens(segment), depth)
    if (!best || r.level > best.level) best = r
  }
  return best || result(0, 'read')
}
function one(raw, depth) {
  let a = raw.slice(), name = base(a[0])
  while (a.length) {
    name = base(a[0])
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0])) { a.shift(); continue }
    if (['env', 'sudo', 'nohup', 'time', 'npx', 'xargs'].includes(name)) {
      a.shift()
      while (a[0]?.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0] || '')) {
        const flag = a.shift()
        if (['-u', '-g', '-C', '-n', '-P', '-I', '--user', '--chdir'].includes(flag)) a.shift()
      }
      continue
    }
    if (name === 'pnpm' && a[1] === 'dlx') { a.splice(0, 2); continue }
    break
  }
  name = base(a[0]); const low = a.map(x => x.toLowerCase()), s = low.join(' ')
  if (['sh', 'bash', 'zsh', 'pwsh', 'powershell'].includes(name)) {
    const at = low.findIndex(x => x === '-c' || x === '-command' || x === '-lc')
    if (at >= 0) return command(a.slice(at + 1).join(' '), depth + 1)
  }
  if (name === 'ssh') {
    let at = 1
    while (a[at]?.startsWith('-')) { const flag = a[at++]; if (['-p', '-i', '-o', '-l', '-F', '-J'].includes(flag)) at++ }
    if (a[at + 1]) return command(a.slice(at + 1).join(' '), depth + 1)
  }
  if ((name === 'codex' && low[1] === 'exec') || (name === 'claude' && low.includes('-p'))) {
    const at = name === 'codex' ? 1 : low.indexOf('-p')
    return command(a.slice(at + 1).join(' '), depth + 1)
  }
  if (['deploy', 'release', 'promote', 'rollback', 'arm', 'migrate'].includes(name)) return result(3, 'script_live')
  if (name === 'systemctl' && low.some(x => ['restart', 'stop', 'start', 'reload', 'enable', 'disable'].includes(x))) return result(3, 'service_change')
  if (['fly', 'flyctl'].includes(name)) {
    if (low.includes('deploy')) return result(3, 'fly_deploy')
    if (low[1] === 'machines' && ['update', 'restart', 'run'].includes(low[2])) return result(3, 'fly_machines')
    if (low[1] === 'scale') return result(3, 'fly_scale')
    if (low[1] === 'secrets' && ['set', 'unset'].includes(low[2])) return result(low.includes('--stage') ? 2 : 3, low.includes('--stage') ? 'fly_secrets_stage' : 'fly_secrets')
    if (['status', 'logs'].includes(low[1])) return result(0, 'fly_read')
  }
  if (name === 'vercel') {
    if (['promote', 'rollback'].includes(low[1]) || low[1] === 'alias' && low[2] === 'set') return result(3, 'vercel_promote')
    if (low.includes('--prod') && !low.includes('--skip-domain')) return result(3, 'vercel_prod')
    if (low[1] === 'deploy' || low.includes('--prod')) return result(2, 'vercel_deploy')
  }
  if (name === 'gh' && low[1] === 'release' && low[2] === 'create') return result(3, 'gh_release')
  if (name === 'gh' && low[1] === 'pr' && ['create', 'merge'].includes(low[2])) return result(2, 'gh_pr')
  if (name === 'git') {
    const at = low.findIndex(x => ['push', 'clean', 'reset', 'commit', 'status', 'log', 'diff'].includes(x))
    const verb = low[at], args = low.slice(at + 1)
    if (verb === 'push') {
      if (args.some(x => x === '-f' || x.startsWith('--force') || x === '--tags')) return result(3, 'git_push_force')
      const targets = args.filter(x => !x.startsWith('-'))
      if (targets.length < 2 || targets.slice(1).some(x => /(?:^|[:/])(main|master)$/.test(x))) return result(3, 'git_push_default')
      return result(2, 'git_push_branch')
    }
    if (verb === 'clean' && args.some(x => /^-[^-]*f[^-]*d[^-]*x|^-[^-]*[fdx]/.test(x)) && ['f', 'd', 'x'].every(c => args.some(x => x.startsWith('-') && x.includes(c)))) return result(3, 'git_clean')
    if (verb === 'reset' && args.includes('--hard')) return result(3, 'git_reset')
    if (verb === 'commit') return result(1, 'git_commit')
    if (['status', 'log', 'diff'].includes(verb)) return result(0, 'git_read')
  }
  if ((['npm', 'pnpm', 'yarn', 'cargo'].includes(name) && low[1] === 'publish') || name === 'twine' && low[1] === 'upload' || name === 'gem' && low[1] === 'push') return result(3, 'package_publish')
  if (name === 'terraform' && ['apply', 'destroy'].includes(low[1])) return result(3, 'terraform_change')
  if (name === 'kubectl' && low.some(x => ['apply', 'delete', 'rollout', 'scale'].includes(x))) return result(3, 'kubectl_change')
  if (name === 'helm' && ['install', 'upgrade', 'rollback'].includes(low[1])) return result(3, 'helm_change')
  if (name === 'docker' && low[1] === 'push') return result(3, 'docker_push')
  if (name === 'wrangler' && low[1] === 'deploy') return result(3, 'wrangler_deploy')
  if (name === 'netlify' && low[1] === 'deploy' && low.includes('--prod')) return result(3, 'netlify_prod')
  if (name === 'rm' && low.some(x => /^-[a-z]*r[a-z]*f|^-[a-z]*f[a-z]*r/.test(x)) && a.some(x => ['~', '/', '..', '$HOME', '${HOME}'].includes(x) || /^(?:~|\$HOME|\$\{HOME\}|\.\.)\//.test(x))) return result(3, 'rm_root')
  if (name === 'git' && /clean/.test(s)) return result(1, 'shell_other')
  if (name === 'psql' && low.some(x => x === '-c' || x.startsWith('--command')) && /\b(drop|truncate)\b/i.test(s)) return result(3, 'sql_destructive')
  const script = /(?:^|[\/_.:-])(deploy|release|promote|rollback|arm|migrate)(?:$|[._:-])/
  if ((['make', 'npm', 'pnpm', 'yarn', 'node', 'python', 'python3', 'bash', 'sh'].includes(name) || raw[0]?.includes('/') || /\.(sh|ps1|js|mjs|py)$/.test(name)) && (low.some(x => script.test(x)) || low.some(x => ['--prod', '--live', '--yes'].includes(x)))) return result(3, 'script_live')
  if (name === 'curl' && !low.some((x, i) => /^-x(?:post|put|delete)$/.test(x) || ['-x', '--request'].includes(x) && ['post', 'put', 'delete'].includes(low[i + 1]))) return result(0, 'curl_read')
  if (['cat', 'ls', 'rg', 'grep', 'head', 'tail', 'pwd', 'find', 'wc', 'get-content', 'get-childitem'].includes(name)) return result(0, 'shell_read')
  return result(1, 'shell_other')
}
export function classify({ tool, input } = {}) {
  try {
    const name = String(tool || '').toLowerCase()
    if (name.startsWith('mcp')) {
      if (/(send|post|publish|merge|deploy|delete|pay|transfer)/.test(name)) return result(3, 'mcp_shared')
      if (/(create|update|comment|upload)/.test(name)) return result(2, 'mcp_write')
      return result(0, 'mcp_read')
    }
    if (READ_TOOLS.has(name)) return result(0, 'read')
    if (WRITE_TOOLS.has(name)) return result(1, 'local_edit')
    if (['bash', 'powershell', 'shell', 'exec_command'].includes(name)) {
      const text = typeof input === 'string' ? input : input?.command ?? input?.cmd ?? ''
      return typeof text === 'string' ? command(text.slice(0, 4000)) : result(0, 'unknown')
    }
    return result(0, 'unknown')
  } catch (_) { return result(0, 'unknown') }
}
