/**
 * js-exec 的 fs 适配。just-bash 在 guest 中压平了 stat、丢弃了 readdir 选项，
 * 并把桥接错误变成普通 Error；这里在用户代码加载前补齐 Node 的文件系统约定。
 */
export const JAVASCRIPT_FS_BOOTSTRAP = String.raw`
(function () {
  var hostKey = Object.getOwnPropertyNames(globalThis).filter(function (name) {
    return name.indexOf('__jbHost_') === 0;
  })[0];
  if (!hostKey) throw new Error('js-exec host bridge is unavailable');
  var host = globalThis[hostKey];
  var fs = globalThis.fs;
  function unwrap(result) {
    if (!result || result.ok !== true) throw new Error(result && result.error || 'Host operation failed');
    return result.value;
  }
  var raw = {};
  var names = [
    'readFileBuffer', 'readFileSync', 'writeFileSync', 'appendFileSync',
    'statSync', 'lstatSync', 'readdirSync', 'mkdirSync', 'rmSync',
    'symlinkSync', 'readlinkSync', 'chmodSync', 'realpathSync',
    'renameSync', 'copyFileSync'
  ];
  for (var index = 0; index < names.length; index++) raw[names[index]] = fs[names[index]];

  var errnos = {
    EPERM: -1,
    ENOENT: -2,
    EIO: -5,
    EACCES: -13,
    EEXIST: -17,
    ENOTDIR: -20,
    EISDIR: -21,
    EINVAL: -22,
    ENOSPC: -28,
    EROFS: -30,
    ENAMETOOLONG: -36,
    ENOTEMPTY: -39,
    ELOOP: -40
  };

  var constants = {
    F_OK: 0,
    R_OK: 4,
    W_OK: 2,
    X_OK: 1,
    COPYFILE_EXCL: 1,
    COPYFILE_FICLONE: 2,
    COPYFILE_FICLONE_FORCE: 4,
    S_IFMT: 61440,
    S_IFREG: 32768,
    S_IFDIR: 16384,
    S_IFLNK: 40960,
    O_RDONLY: 0,
    O_WRONLY: 1,
    O_RDWR: 2,
    O_CREAT: 64,
    O_EXCL: 128,
    O_TRUNC: 512,
    O_APPEND: 1024
  };

  function failure(error, syscall, target, destination) {
    if (!(error instanceof Error)) error = new Error(String(error));
    var matched = /^([A-Z][A-Z0-9]+):/.exec(error.message);
    if (matched) {
      error.code = matched[1];
      if (errnos[error.code] !== undefined) error.errno = errnos[error.code];
    }
    error.syscall = syscall;
    if (target !== undefined) {
      error.path = String(target);
      error.message = error.message.replace(/'[^']*'(?=\s*$)/, "'" + String(target).replace(/'/g, "\\'") + "'");
    }
    if (destination !== undefined) error.dest = String(destination);
    return error;
  }

  function filePath(value) {
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof value.href !== 'string' ||
      typeof value.protocol !== 'string'
    ) return value;
    if (value.protocol !== 'file:') {
      throw failure(new Error('ERR_INVALID_URL_SCHEME: The URL must be of scheme file, received ' + value.protocol), 'open', value.href);
    }
    if (value.hostname && value.hostname !== 'localhost') {
      throw failure(new Error('ERR_INVALID_FILE_URL_HOST: File URL host must be "localhost" or empty, received ' + value.hostname), 'open', value.href);
    }
    return decodeURIComponent(value.pathname);
  }

  function bridge(hostName, syscall, target, args, destination) {
    try {
      var operation = host[hostName];
      if (args.length === 1) return unwrap(operation(args[0]));
      if (args.length === 2) return unwrap(operation(args[0], args[1]));
      if (args.length === 3) return unwrap(operation(args[0], args[1], args[2]));
      return unwrap(operation(args[0], args[1], args[2], args[3]));
    } catch (error) {
      throw failure(error, syscall, target, destination);
    }
  }

  function bytes(value) {
    if (value && value._data instanceof Uint8Array) return Array.from(value._data);
    if (value && Array.isArray(value._data)) return value._data.slice();
    if (Array.isArray(value)) return value.slice();
    if (value instanceof Uint8Array) return Array.from(value);
    return String(value);
  }

  function Stats() {}
  function Dirent() {}

  function stats(value) {
    var mtime = value.mtime instanceof Date ? value.mtime : new Date(value.mtime);
    var size = Number(value.size);
    var result = Object.create(Stats.prototype);
    result.dev = 0;
    result.ino = 0;
    result.mode = Number(value.mode);
    result.nlink = value.isDirectory ? 2 : 1;
    result.uid = 1000;
    result.gid = 1000;
    result.rdev = 0;
    result.size = size;
    result.blksize = 4096;
    result.blocks = Math.ceil(size / 512);
    result.atime = mtime;
    result.mtime = mtime;
    result.ctime = mtime;
    result.birthtime = mtime;
    result.atimeMs = mtime.getTime();
    result.mtimeMs = mtime.getTime();
    result.ctimeMs = mtime.getTime();
    result.birthtimeMs = mtime.getTime();
    result.isFile = function () { return value.isFile; };
    result.isDirectory = function () { return value.isDirectory; };
    result.isSymbolicLink = function () { return value.isSymbolicLink; };
    result.isBlockDevice = function () { return false; };
    result.isCharacterDevice = function () { return false; };
    result.isFIFO = function () { return false; };
    result.isSocket = function () { return false; };
    return result;
  }

  function dirent(name, parentPath, value) {
    var result = Object.create(Dirent.prototype);
    result.name = String(name);
    result.parentPath = String(parentPath);
    result.path = String(parentPath);
    result.isFile = function () { return value.isFile; };
    result.isDirectory = function () { return value.isDirectory; };
    result.isSymbolicLink = function () { return value.isSymbolicLink; };
    result.isBlockDevice = function () { return false; };
    result.isCharacterDevice = function () { return false; };
    result.isFIFO = function () { return false; };
    result.isSocket = function () { return false; };
    return result;
  }

  function childPath(parent, name) {
    return parent.charAt(parent.length - 1) === '/' ? parent + name : parent + '/' + name;
  }

  function readStats(path, follow) {
    var target = filePath(path);
    return bridge('fsStat', follow ? 'stat' : 'lstat', target, [target, !follow]);
  }

  function collect(path, relative, options, output) {
    var listing = bridge('fsReaddir', 'scandir', path, [path]);
    for (var index = 0; index < listing.length; index++) {
      var name = listing[index];
      var nested = relative === '' ? name : relative + '/' + name;
      var full = childPath(path, name);
      var value = readStats(full, false);
      output.push(options.withFileTypes ? dirent(name, path, value) : nested);
      if (options.recursive && value.isDirectory) collect(full, nested, options, output);
    }
  }

  function readdir(path, options) {
    var target = filePath(path);
    if (typeof options === 'string') options = { encoding: options };
    options = options || {};
    var output = [];
    collect(target, '', { recursive: Boolean(options.recursive), withFileTypes: Boolean(options.withFileTypes) }, output);
    if (options.encoding === 'buffer') return output.map(function (entry) {
      return typeof entry === 'string' ? Buffer.from(entry) : entry;
    });
    return output;
  }

  function firstCreated(path) {
    var text = String(filePath(path));
    var absolute = text.charAt(0) === '/';
    var parts = text.split('/');
    var current = '';
    var found;
    for (var index = 0; index < parts.length; index++) {
      var part = parts[index];
      if (part === '' || part === '.') continue;
      if (current === '') current = absolute ? '/' + part : part;
      else current = childPath(current, part);
      if (!fs.existsSync(current)) {
        found = current;
        break;
      }
    }
    return found;
  }

  fs.readFileBuffer = function (path) {
    var target = filePath(path);
    try {
      return Buffer.from(raw.readFileBuffer(target));
    } catch (error) {
      throw failure(error, 'open', target);
    }
  };
  fs.readFileSync = function (path, options) {
    var target = filePath(path);
    try {
      return raw.readFileSync(target, options);
    } catch (error) {
      throw failure(error, 'open', target);
    }
  };
  fs.writeFileSync = function (path, data) {
    var target = filePath(path);
    bridge('fsWrite', 'open', target, [target, bytes(data)]);
  };
  fs.appendFileSync = function (path, data) {
    var target = filePath(path);
    bridge('fsAppend', 'open', target, [target, bytes(data)]);
  };
  fs.statSync = function (path) {
    return stats(readStats(path, true));
  };
  fs.lstatSync = function (path) {
    return stats(readStats(path, false));
  };
  fs.readdirSync = readdir;
  fs.mkdirSync = function (path, options) {
    var target = filePath(path);
    var recursive = Boolean(options && typeof options === 'object' && options.recursive);
    var created = recursive ? firstCreated(target) : undefined;
    bridge('fsMkdir', 'mkdir', target, [target, recursive]);
    return created;
  };
  fs.rmSync = function (path, options) {
    var target = filePath(path);
    bridge('fsRm', 'rm', target, [target, Boolean(options && options.recursive), Boolean(options && options.force)]);
  };
  fs.existsSync = function (path) {
    var target = filePath(path);
    try {
      return bridge('fsExists', 'access', target, [target]);
    } catch (error) {
      return false;
    }
  };
  fs.accessSync = function (path, mode) {
    var target = filePath(path);
    if (!bridge('fsExists', 'access', target, [target])) {
      throw failure(new Error("ENOENT: no such file or directory, access '" + target + "'"), 'access', target);
    }
    var flags = mode === undefined ? 0 : Number(mode);
    if ((flags & ~7) !== 0) {
      throw failure(new Error("EINVAL: invalid mode argument, access '" + target + "'"), 'access', target);
    }
    if (flags === 0) return;
    var permissions = stats(readStats(target, true)).mode & 511;
    var required = 0;
    if (flags & constants.R_OK) required |= 256;
    if (flags & constants.W_OK) required |= 128;
    if (flags & constants.X_OK) required |= 64;
    if ((permissions & required) !== required) {
      throw failure(new Error("EACCES: permission denied, access '" + target + "'"), 'access', target);
    }
  };
  fs.symlinkSync = function (target, path) {
    var link = filePath(path);
    bridge('fsSymlink', 'symlink', link, [filePath(target), link]);
  };
  fs.readlinkSync = function (path) {
    var target = filePath(path);
    return bridge('fsReadlink', 'readlink', target, [target]);
  };
  fs.chmodSync = function (path, mode) {
    var target = filePath(path);
    bridge('fsChmod', 'chmod', target, [target, Number(mode)]);
  };
  fs.realpathSync = function (path) {
    var target = filePath(path);
    return bridge('fsRealpath', 'realpath', target, [target]);
  };
  fs.renameSync = function (from, to) {
    var source = filePath(from);
    var destination = filePath(to);
    bridge('fsRename', 'rename', source, [source, destination], destination);
  };
  fs.copyFileSync = function (from, to, mode) {
    var source = filePath(from);
    var destination = filePath(to);
    if ((Number(mode) || 0) & constants.COPYFILE_EXCL && fs.existsSync(destination)) {
      throw failure(new Error("EEXIST: file already exists, copyfile '" + destination + "'"), 'copyfile', source, destination);
    }
    bridge('fsCopy', 'copyfile', source, [source, destination], destination);
  };
  fs.unlinkSync = function (path) {
    var target = filePath(path);
    bridge('fsRm', 'unlink', target, [target, false, false]);
  };
  fs.rmdirSync = function (path, options) {
    var target = filePath(path);
    bridge('fsRm', 'rmdir', target, [target, Boolean(options && options.recursive), false]);
  };
  fs.constants = constants;
  fs.Stats = Stats;
  fs.Dirent = Dirent;

  var callbackNames = [
    ['readFile', fs.readFileSync],
    ['writeFile', fs.writeFileSync],
    ['appendFile', fs.appendFileSync],
    ['stat', fs.statSync],
    ['lstat', fs.lstatSync],
    ['readdir', fs.readdirSync],
    ['mkdir', fs.mkdirSync],
    ['rm', fs.rmSync],
    ['symlink', fs.symlinkSync],
    ['readlink', fs.readlinkSync],
    ['chmod', fs.chmodSync],
    ['realpath', fs.realpathSync],
    ['rename', fs.renameSync],
    ['copyFile', fs.copyFileSync],
    ['unlink', fs.unlinkSync],
    ['rmdir', fs.rmdirSync]
  ];
  function callbackify(name, sync) {
    fs[name] = function () {
      var args = Array.prototype.slice.call(arguments);
      var callback = args.pop();
      if (typeof callback !== 'function') throw new TypeError('The "cb" argument must be of type function. Received ' + typeof callback);
      Promise.resolve().then(function () {
        return sync.apply(fs, args);
      }).then(function (value) {
        callback(null, value);
      }, function (error) {
        callback(error);
      });
    };
  }
  for (var index = 0; index < callbackNames.length; index++) callbackify(callbackNames[index][0], callbackNames[index][1]);
  fs.exists = function (path, callback) {
    if (typeof callback !== 'function') throw new TypeError('The "cb" argument must be of type function. Received ' + typeof callback);
    Promise.resolve().then(function () { callback(fs.existsSync(path)); });
  };

  var promiseNames = [
    'readFile', 'writeFile', 'appendFile', 'stat', 'lstat', 'readdir',
    'mkdir', 'rm', 'symlink', 'readlink', 'chmod', 'realpath',
    'rename', 'copyFile', 'unlink', 'rmdir'
  ];
  fs.promises = {};
  for (var index = 0; index < promiseNames.length; index++) (function (name) {
    var sync = fs[name + 'Sync'];
    fs.promises[name] = function () {
      var args = arguments;
      return new Promise(function (resolve, reject) {
        Promise.resolve().then(function () {
          return sync.apply(fs, args);
        }).then(resolve, reject);
      });
    };
  })(promiseNames[index]);
  fs.promises.access = function (path, mode) {
    return new Promise(function (resolve, reject) {
      Promise.resolve().then(function () {
        fs.accessSync(path, mode);
      }).then(resolve, reject);
    });
  };

  globalThis.fs = fs;
})();
`;
