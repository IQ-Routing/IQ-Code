

import { bytesFromBase64, projectEnvNames, steersProgram } from './util.js'
export const SETTINGS_TRANSACTION = String.raw`
const fs = require('node:fs'), path = require('node:path');
let target = process.argv[1];
const patch = JSON.parse(process.argv[2]);
const leaseMode = ['acquire', 'release'].includes(process.argv[3]);
const fileMode = process.argv[3] === 'file' || leaseMode;
const home = process.argv[4] || path.resolve(target, fileMode ? '../../../..' : '../../..');
const relative = fileMode ? '.claude/iq/router/sessions.json' : '.claude/iq/settings.json';
if (path.resolve(target) !== path.resolve(home, relative)) process.exit(1);
let lock = target + '.lock', reclaim = lock + '.reclaim';
const directories = [];
// Another user's directory or a world-writable one could redirect or replace
// our files. A group-writable directory (umask 002) is the person's own setup.
function checkDirectory(directory) {
  const info = fs.lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory() ||
      (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o002)))) throw Error('settings_home_untrusted');
  return info;
}
function prepareDirectories() {
  let directory = home, first = true, relinked = false;
  for (const part of relative.split('/').slice(0, -1)) {
    checkDirectories();
    directory = path.join(directory, part);
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    // Dotfiles setups link ~/.claude elsewhere. Resolve that one link once and
    // hold the real directory by identity; every deeper link stays refused.
    if (first && fs.lstatSync(directory).isSymbolicLink()) { directory = fs.realpathSync(directory); relinked = true; }
    first = false;
    const info = checkDirectory(directory);
    directories.push({ directory, dev: info.dev, ino: info.ino });
  }
  if (relinked) { target = path.join(directory, path.basename(target)); lock = target + '.lock'; reclaim = lock + '.reclaim'; }
}
function checkDirectories() {
  for (const saved of directories) {
    const info = checkDirectory(saved.directory);
    if (saved.dev !== info.dev || saved.ino !== info.ino) throw Error('settings_home_changed');
  }
}
function readBounded(file, cap) {
  checkDirectories();
  try { if (fs.lstatSync(file).isSymbolicLink()) throw Error('settings_read_unavailable'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let input;
  try { input = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const info = fs.fstatSync(input);
    if (!info.isFile() || info.size > cap) throw Error('settings_read_unavailable');
    const chunks = [], chunk = Buffer.alloc(65536);
    let size = 0, count;
    while ((count = fs.readSync(input, chunk, 0, Math.min(chunk.length, cap + 1 - size), null)) > 0) {
      chunks.push(Buffer.from(chunk.subarray(0, count))); size += count;
      if (size > cap) throw Error('settings_read_unavailable');
    }
    return Buffer.concat(chunks);
  } finally { fs.closeSync(input); }
}
function replacePrivate(file, text) {
  const temporary = file + '.' + process.pid + '.tmp';
  let created = false;
  try {
    checkDirectories();
    fs.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' }); created = true;
    checkDirectories();
    fs.renameSync(temporary, file);
  } finally {
    if (created) { try { checkDirectories(); fs.unlinkSync(temporary); } catch (_) {} }
  }
}
function readRequest() {
  const chunks = [], buffer = Buffer.alloc(65536), limit = 4 * 1024 * 1024;
  let size = 0, count;
  while ((count = fs.readSync(0, buffer, 0, Math.min(buffer.length, limit + 1 - size), null)) > 0) {
    chunks.push(Buffer.from(buffer.subarray(0, count))); size += count;
    if (size > limit) throw Error('file_request_unavailable');
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function ownerAlive() {
  try {
    const owner = JSON.parse(readBounded(lock, 2048).toString('utf8')).owner;
    if (!Number.isSafeInteger(owner) || owner < 2) return false;
    try { process.kill(owner, 0); return true; }
    catch (error) { return error.code !== 'ESRCH'; }
  } catch (_) { return false; }
}
function secureExisting(file) {
  checkDirectories();
  try { if (fs.lstatSync(file).isSymbolicLink()) throw Error('settings_read_unavailable'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const input = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const info = fs.fstatSync(input);
    if (!info.isFile() || info.nlink !== 1 || process.getuid && info.uid !== process.getuid()) throw Error('settings_read_unavailable');
    fs.fchmodSync(input, 0o600);
  } finally { fs.closeSync(input); }
}
function fileTransaction() {
  const request = readRequest();
  if (!request || request.path !== relative || !['snapshot', 'compare'].includes(request.op) ||
      !Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1 || request.maxBytes > 1048576) throw Error('file_request_invalid');
  // TaskState rejects snapshots over its 1 MiB schema cap, but the legacy host
  // reader allowed a bounded 4 MiB file to be backed up before recovery.
  const raw = readBounded(target, 4 * 1024 * 1024);
  const version = raw === null ? null : require('node:crypto').createHash('sha256').update(raw).digest('hex');
  if (request.op === 'snapshot' || request.expectedVersion !== version) {
    // Base64 has fixed expansion; JSON-escaped corrupt control bytes can exceed
    // the native host's 4 MiB stdout cap even for a 1 MiB input file.
    const oversized = raw !== null && raw.length > request.maxBytes;
    return { ...(request.op === 'compare' ? { committed: false } : {}), ...(oversized ? { oversized: true } : {}),
      base64: raw === null ? null : oversized ? '' : raw.toString('base64'), version };
  }
  if (typeof request.text !== 'string' || Buffer.byteLength(request.text) > request.maxBytes || typeof request.backup !== 'boolean') throw Error('file_request_invalid');
  if (raw !== null && raw.length > request.maxBytes && !request.backup) throw Error('file_request_invalid');
  if (request.backup && raw !== null) replacePrivate(target + '.bad', raw);
  replacePrivate(target, request.text);
  return { committed: true };
}
(async () => {
  prepareDirectories();
  const lease = leaseMode ? readRequest() : null;
  if (leaseMode && (!lease || lease.path !== relative || lease.op !== process.argv[3] || !/^[a-f0-9]{32}$/.test(lease.token))) throw Error('file_request_invalid');
  if (lease?.op === 'release') {
    let reclaiming = false;
    try {
      for (let attempt = 0; attempt < 200; attempt++) {
        try { if (Date.now() - fs.lstatSync(reclaim).mtimeMs > 30000) fs.rmdirSync(reclaim); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        try { fs.mkdirSync(reclaim, { mode: 0o700 }); reclaiming = true; break; }
        catch (error) { if (error.code !== 'EEXIST') throw error; await new Promise(resolve => setTimeout(resolve, 10)); }
      }
      if (!reclaiming) throw Error('settings_lock_busy');
      const raw = readBounded(lock, 2048);
      if (raw === null) return;
      if (JSON.parse(raw.toString('utf8')).token !== lease.token) throw Error('settings_lock_owner');
      try { secureExisting(target); secureExisting(target + '.bad'); }
      finally { checkDirectories(); fs.unlinkSync(lock); }
    } finally { if (reclaiming) { checkDirectories(); fs.rmdirSync(reclaim); } }
    return;
  }
  let fd;
  for (let attempt = 0; attempt < 200; attempt++) {
    checkDirectories();
    try { fd = fs.openSync(lock, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let reclaiming = false;
      try {
        try { if (Date.now() - fs.lstatSync(reclaim).mtimeMs > 30000) fs.rmdirSync(reclaim); }
        catch (markerError) { if (markerError.code !== 'ENOENT') throw markerError; }
        fs.mkdirSync(reclaim, { mode: 0o700 }); reclaiming = true;
        // A lease whose release was lost stays tied to a live host, so age alone expires it.
        const age = Date.now() - fs.lstatSync(lock).mtimeMs;
        if (age > 30000 || age > 10000 && !ownerAlive()) { fs.unlinkSync(lock); continue; }
      } catch (lockError) { if (lockError.code === 'ENOENT') continue; if (lockError.code !== 'EEXIST') throw lockError; }
      finally { if (reclaiming) { checkDirectories(); try { fs.rmdirSync(reclaim); } catch (error) { if (error.code !== 'ENOENT') throw error; } } }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  if (fd === undefined) throw Error('settings_lock_busy');
  let retained = false;
  try {
    if (lease) {
      // Keep new host-created files private until release tightens their mode.
      fs.chmodSync(path.dirname(target), 0o700);
      secureExisting(target); secureExisting(target + '.bad');
      // The host, not this short-lived helper, owns the transaction lifetime.
      fs.writeFileSync(fd, JSON.stringify({ v: 1, token: lease.token, owner: process.ppid }));
      retained = true;
      return;
    }
    if (fileMode) { process.stdout.write(JSON.stringify(fileTransaction())); return; }
    let current = {}, recovered = false;
    const raw = readBounded(target, 4 * 1024 * 1024);
    if (raw !== null) {
      try { current = JSON.parse(raw.toString('utf8')); }
      catch (error) { if (error instanceof SyntaxError) recovered = true; else throw error; }
    }
    if (!current || typeof current !== 'object' || Array.isArray(current)) recovered = true;
    if (recovered) current = { keepRoutingOn: false, authBlocked: true, routingEligible: false, usageReporting: 'off' };
    const merged = { ...current, ...patch, v: 1 };
    if (recovered && patch.usageReporting !== 'on') merged.usageReporting = 'off';
    delete merged.subagentRouting;
    replacePrivate(target, JSON.stringify(merged, null, 1) + '\n');
    process.stdout.write(JSON.stringify(Object.fromEntries(['keepRoutingOn', 'authBlocked', 'routingEligible', 'usageReporting'].filter(key => Object.hasOwn(merged, key)).map(key => [key, merged[key]]))));
  } finally {
    fs.closeSync(fd);
    checkDirectories();
    if (!retained) fs.unlinkSync(lock);
  }
})().catch(() => { process.exitCode = 1; });
`




export const SETTINGS_PYTHON_TRANSACTION = String.raw`
import base64, hashlib, json, os, stat, sys, time
target, raw_patch = sys.argv[1:3]
patch = json.loads(raw_patch)
lease_mode = len(sys.argv) > 3 and sys.argv[3] in ('acquire', 'release')
file_mode = len(sys.argv) > 3 and (sys.argv[3] == 'file' or lease_mode)
relative = '.claude/iq/router/sessions.json' if file_mode else '.claude/iq/settings.json'
home = sys.argv[4] if len(sys.argv) > 4 else os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(target) if file_mode else target)))
if os.path.abspath(target) != os.path.abspath(os.path.join(home, relative)):
    sys.exit(1)
parent, fd = None, None
name = os.path.basename(target)
lock, reclaim = name + '.lock', name + '.lock.reclaim'
def invalid_constant(value):
    raise ValueError('invalid JSON constant')
def remove_missing_ok(name, directory=False):
    try:
        (os.rmdir if directory else os.unlink)(name, dir_fd=parent)
    except FileNotFoundError:
        pass
def prepare_parent():
    directory = os.open(home, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for index, part in enumerate(relative.split('/')[:-1]):
            try:
                os.mkdir(part, 0o700, dir_fd=directory)
            except FileExistsError:
                pass
            if index == 0 and stat.S_ISLNK(os.lstat(part, dir_fd=directory).st_mode):
                # Dotfiles setups link ~/.claude elsewhere. Resolve that one link
                # once; the opened descriptor is checked and used from here on.
                child = os.open(os.path.realpath(os.path.join(home, part)), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            else:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            info = os.fstat(child)
            # Another user's directory or a world-writable one is refused. A
            # group-writable directory (umask 002) is the person's own setup.
            if info.st_uid != os.getuid() or info.st_mode & 0o002:
                os.close(child)
                raise RuntimeError('settings_home_untrusted')
            os.close(directory)
            directory = child
        return directory
    except BaseException:
        os.close(directory)
        raise
def read_bounded(cap):
    try:
        source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    except FileNotFoundError:
        return None
    try:
        info = os.fstat(source)
        if not stat.S_ISREG(info.st_mode) or info.st_size > cap:
            raise RuntimeError('settings_read_unavailable')
        chunks, size = [], 0
        while True:
            chunk = os.read(source, min(65536, cap + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > cap:
                raise RuntimeError('settings_read_unavailable')
        return b''.join(chunks)
    finally:
        os.close(source)
def replace_private(name, raw):
    temporary, created = name + '.' + str(os.getpid()) + '.tmp', False
    try:
        out = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600, dir_fd=parent)
        created = True
        with os.fdopen(out, 'wb') as destination:
            destination.write(raw)
            destination.flush()
            os.fsync(destination.fileno())
        os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
    finally:
        if created:
            remove_missing_ok(temporary)
def read_request():
    raw_request = sys.stdin.buffer.read(4 * 1024 * 1024 + 1)
    if len(raw_request) > 4 * 1024 * 1024:
        raise RuntimeError('file_request_unavailable')
    return json.loads(raw_request, parse_constant=invalid_constant)
def owner_alive():
    try:
        descriptor = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                return False
            owner = json.loads(os.read(descriptor, 2049))['owner']
        finally:
            os.close(descriptor)
        if type(owner) != int or owner < 2:
            return False
        try:
            os.kill(owner, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
    except (OSError, ValueError, KeyError, TypeError):
        return False
def secure_existing(name):
    try:
        source = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    except FileNotFoundError:
        return
    try:
        info = os.fstat(source)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid():
            raise RuntimeError('settings_read_unavailable')
        os.fchmod(source, 0o600)
    finally:
        os.close(source)
def file_transaction():
    request = read_request()
    if not isinstance(request, dict) or request.get('path') != relative or request.get('op') not in ('snapshot', 'compare') or type(request.get('maxBytes')) != int or not 1 <= request['maxBytes'] <= 1048576:
        raise RuntimeError('file_request_invalid')
    raw = read_bounded(4 * 1024 * 1024)
    version = None if raw is None else hashlib.sha256(raw).hexdigest()
    if request['op'] == 'snapshot' or request.get('expectedVersion') != version:
        oversized = raw is not None and len(raw) > request['maxBytes']
        reply = dict(base64=None if raw is None else '' if oversized else base64.b64encode(raw).decode('ascii'), version=version)
        if oversized:
            reply['oversized'] = True
        if request['op'] == 'compare':
            reply['committed'] = False
        return reply
    if not isinstance(request.get('text'), str) or type(request.get('backup')) != bool:
        raise RuntimeError('file_request_invalid')
    text = request['text'].encode('utf-8')
    if len(text) > request['maxBytes']:
        raise RuntimeError('file_request_invalid')
    if raw is not None and len(raw) > request['maxBytes'] and not request['backup']:
        raise RuntimeError('file_request_invalid')
    if request['backup'] and raw is not None:
        replace_private(name + '.bad', raw)
    replace_private(name, text)
    return dict(committed=True)
try:
    parent = prepare_parent()
    lease = read_request() if lease_mode else None
    if lease_mode and (not isinstance(lease, dict) or lease.get('path') != relative or lease.get('op') != sys.argv[3] or not isinstance(lease.get('token'), str) or len(lease['token']) != 32 or any(c not in '0123456789abcdef' for c in lease['token'])):
        raise RuntimeError('file_request_invalid')
    if lease_mode and lease['op'] == 'release':
        reclaiming = False
        try:
            for attempt in range(200):
                try:
                    if time.time() - os.stat(reclaim, dir_fd=parent, follow_symlinks=False).st_mtime > 30:
                        os.rmdir(reclaim, dir_fd=parent)
                except FileNotFoundError:
                    pass
                try:
                    os.mkdir(reclaim, 0o700, dir_fd=parent)
                    reclaiming = True
                    break
                except FileExistsError:
                    time.sleep(0.01)
            if not reclaiming:
                raise RuntimeError('settings_lock_busy')
            try:
                source = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            except FileNotFoundError:
                sys.exit(0)
            try:
                if not stat.S_ISREG(os.fstat(source).st_mode) or json.loads(os.read(source, 2049)).get('token') != lease['token']:
                    raise RuntimeError('settings_lock_owner')
            finally:
                os.close(source)
            try:
                secure_existing(name)
                secure_existing(name + '.bad')
            finally:
                os.unlink(lock, dir_fd=parent)
        finally:
            if reclaiming:
                remove_missing_ok(reclaim, True)
        sys.exit(0)
    for attempt in range(200):
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600, dir_fd=parent)
            break
        except FileExistsError:
            reclaiming = False
            try:
                try:
                    if time.time() - os.stat(reclaim, dir_fd=parent, follow_symlinks=False).st_mtime > 30:
                        os.rmdir(reclaim, dir_fd=parent)
                except FileNotFoundError:
                    pass
                os.mkdir(reclaim, 0o700, dir_fd=parent)
                reclaiming = True
                # A lease whose release was lost stays tied to a live host, so age alone expires it.
                age = time.time() - os.stat(lock, dir_fd=parent, follow_symlinks=False).st_mtime
                if age > 30 or age > 10 and not owner_alive():
                    os.unlink(lock, dir_fd=parent)
                    continue
            except FileNotFoundError:
                continue
            except FileExistsError:
                pass
            finally:
                if reclaiming:
                    remove_missing_ok(reclaim, True)
            time.sleep(0.01)
    if fd is None:
        raise RuntimeError('settings_lock_busy')
    retained = False
    try:
        if lease_mode:
            os.fchmod(parent, 0o700)
            secure_existing(name)
            secure_existing(name + '.bad')
            os.write(fd, json.dumps(dict(v=1, token=lease['token'], owner=os.getppid())).encode('ascii'))
            retained = True
        elif file_mode:
            reply = file_transaction()
        else:
            current, recovered = {}, False
            raw = read_bounded(4 * 1024 * 1024)
            if raw is not None:
                try:
                    current = json.loads(raw.decode('utf-8'), parse_constant=invalid_constant)
                except (ValueError, UnicodeError):
                    recovered = True
            if not isinstance(current, dict):
                recovered = True
            if recovered:
                current = dict(keepRoutingOn=False, authBlocked=True, routingEligible=False, usageReporting='off')
            merged = dict(current, **patch)
            merged['v'] = 1
            if recovered and patch.get('usageReporting') != 'on':
                merged['usageReporting'] = 'off'
            merged.pop('subagentRouting', None)
            replace_private(name, (json.dumps(merged, indent=1, ensure_ascii=False) + '\n').encode('utf-8'))
            reply = {key: merged[key] for key in ('keepRoutingOn', 'authBlocked', 'routingEligible', 'usageReporting') if key in merged}
        if not lease_mode:
            sys.stdout.write(json.dumps(reply, ensure_ascii=False))
    finally:
        os.close(fd)
        if not retained:
            os.unlink(lock, dir_fd=parent)
except SystemExit:
    raise
except BaseException:
    sys.exit(1)
finally:
    if parent is not None:
        os.close(parent)
`






const missingRuntime = error => {
  const message = String(error?.message)
  if (/\bfailed to start\b/i.test(message)) return true
  if (error?.code !== undefined) return error.code === 'ENOENT'
  return !/^\s*Command failed\b/i.test(message) && /\bENOENT\b/.test(message)
}



const stubbedRuntimes = new Set()
const developerToolsStub = (argv, result) => argv[1] === '-I' && result?.exitCode !== 0 && /xcode-select/i.test(String(result?.stderr))



const DEVELOPER_PYTHONS = ['/Library/Developer/CommandLineTools/usr/bin/python3', '/Applications/Xcode.app/Contents/Developer/usr/bin/python3']
async function shimWouldPrompt(access) {
  if (typeof access.exists !== 'function') return false
  try {
    if (await access.exists('/usr/bin/xcode-select') !== true) return false
    for (const path of DEVELOPER_PYTHONS) if (await access.exists(path) === true) return false
    return true
  } catch (_) { return false }
}
const SESSION_FILE = '.claude/iq/router/sessions.json'
const SETTINGS_FILE = '.claude/iq/settings.json'


export const SETTINGS_HELPER_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'
const noRuntime = () => new Error('settings_runtime_unavailable')
const fileIn = (home, relative) => /^[A-Za-z]:[\\/]/.test(home)
  ? home.replace(/[\\/]+$/, '') + '\\' + relative.replace(/\//g, '\\') : home.replace(/[\\/]+$/, '') + '/' + relative

async function transaction(access, home, relative, patch, processEnv, request) {
  if (typeof access.run !== 'function') throw noRuntime()
  const windows = /^[A-Za-z]:[\\/]/.test(home)
  const target = fileIn(home, relative)
  const leaseMode = ['acquire', 'release'].includes(request?.op)
  const args = [target, JSON.stringify(patch), leaseMode ? request.op : request ? 'file' : 'settings', home]
  const candidates = windows
    ? [[home.slice(0, 2) + '\\Program Files\\nodejs\\node.exe', '-e', SETTINGS_TRANSACTION, ...args]]
    : ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'].map(path => [path, '-e', SETTINGS_TRANSACTION, ...args])
  if (!windows) candidates.push(...['/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3']
    .map(path => [path, '-I', '-c', SETTINGS_PYTHON_TRANSACTION, ...args]))
  const env = { ...processEnv, ...(windows ? {} : { PATH: SETTINGS_HELPER_PATH }) }





  const steering = await projectEnvNames(access.readSettings)
  for (const argv of candidates) {
    if (stubbedRuntimes.has(argv[0])) continue
    if (steersProgram(steering, argv[0], processEnv)) continue
    if (argv[0] === '/usr/bin/python3' && await shimWouldPrompt(access)) continue
    let result
    try { result = await access.run(argv, { timeoutMs: 5000, cwd: home, env: { ...env }, ...(request ? { stdin: JSON.stringify(request) } : {}) }) }
    catch (error) {
      if (missingRuntime(error)) continue
      throw new Error('settings_transaction_failed')
    }
    if (developerToolsStub(argv, result)) { stubbedRuntimes.add(argv[0]); continue }


    if (result?.exitCode !== 0 || result.isStdoutTruncated === true || typeof result.stdout !== 'string' || result.stdout.length > 4 * 1024 * 1024) throw new Error('settings_transaction_failed')
    if (leaseMode) return
    let saved
    try { saved = JSON.parse(result.stdout) } catch (_) { throw new Error('settings_transaction_failed') }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('settings_transaction_failed')
    return saved
  }
  throw noRuntime()
}




async function hostSettingsWrite(access, target, changes) {
  if (typeof access.exists !== 'function' || typeof access.read !== 'function' || typeof access.write !== 'function') throw noRuntime()
  const exists = await access.exists(target)
  if (exists !== true && exists !== false) throw new Error('settings_read_unavailable')
  let current = {}, recovered = false
  if (exists) {
    const stored = await access.read(target)
    if (typeof stored === 'string' && stored.length > 4 * 1024 * 1024) throw new Error('settings_read_unavailable')
    try { current = JSON.parse(stored) }
    catch (error) { if (error instanceof SyntaxError) recovered = true; else throw error }
    if (!current || typeof current !== 'object' || Array.isArray(current)) recovered = true
  }


  if (recovered) current = { keepRoutingOn: false, authBlocked: true, routingEligible: false, usageReporting: 'off' }
  const merged = { ...current, ...changes, v: 1 }
  if (recovered && changes.usageReporting !== 'on') merged.usageReporting = 'off'
  delete merged.subagentRouting
  await access.write(target, JSON.stringify(merged, null, 1) + '\n')
  return Object.fromEntries(['keepRoutingOn', 'authBlocked', 'routingEligible', 'usageReporting'].filter(key => Object.hasOwn(merged, key)).map(key => [key, merged[key]]))
}

export async function writeSettingsStore(access, home, changes, processEnv) {
  try { return await transaction(access, home, SETTINGS_FILE, changes, processEnv) }
  catch (error) {


    if (error?.message !== 'settings_runtime_unavailable') throw error
  }
  return hostSettingsWrite(access, fileIn(home, SETTINGS_FILE), changes)
}






export async function withSessionStoreLock(access, home, action, processEnv, stillCurrent = () => true) {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
  const request = { path: SESSION_FILE, token }
  const acquire = typeof access.run !== 'function' ? {} : { readSettings: access.readSettings, run: async (argv, init) => {
    if (await stillCurrent() !== true) throw new Error('session_save_cancelled')
    return access.run(argv, init)
  } }
  let attempted = true
  try {
    try { await transaction(acquire, home, SESSION_FILE, {}, processEnv, { ...request, op: 'acquire' }) }
    catch (error) {
      if (error?.message !== 'settings_runtime_unavailable') throw error
      attempted = false
    }
    if (await stillCurrent() !== true) return false
    return await action()
  } finally {


    if (attempted) try { await transaction(access, home, SESSION_FILE, {}, processEnv, { ...request, op: 'release' }) } catch (_) {}
  }
}



export async function fileStoreTransaction(access, home, request, processEnv) {
  if (!request || request.path !== SESSION_FILE || !['snapshot', 'compare'].includes(request.op) ||
      !Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1 || request.maxBytes > 1048576 ||
      (request.op === 'compare' && (typeof request.text !== 'string' || request.text.length > request.maxBytes ||
        typeof request.backup !== 'boolean' || request.expectedVersion !== null && !/^[a-f0-9]{64}$/.test(request.expectedVersion)))) throw new Error('settings_transaction_failed')
  const result = await transaction(access, home, SESSION_FILE, {}, processEnv, request)
  if (request.op === 'compare' && result.committed === true) return result
  if ((request.op === 'compare' && result.committed !== false) ||
      (result.oversized !== undefined && (result.oversized !== true || result.base64 !== '' || typeof result.version !== 'string')) ||
      !(result.base64 === null && result.version === null || typeof result.base64 === 'string' &&
        result.base64.length <= 4 * Math.ceil(request.maxBytes / 3) && result.base64.length % 4 === 0 &&
        /^[A-Za-z0-9+/]*={0,2}$/.test(result.base64) && typeof result.version === 'string' && /^[a-f0-9]{64}$/.test(result.version))) throw new Error('settings_transaction_failed')
  let text = null
  if (result.base64 !== null) {
    const bytes = bytesFromBase64(result.base64)
    if (bytes.length > request.maxBytes) throw new Error('settings_transaction_failed')
    text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
  }
  return { ...(request.op === 'compare' ? { committed: false } : {}), ...(result.oversized ? { oversized: true } : {}), text, version: result.version }
}
