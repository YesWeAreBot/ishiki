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

  function stats(value) {
    var mtime = value.mtime instanceof Date ? value.mtime : new Date(value.mtime);
    var size = Number(value.size);
    var result = {
      dev: 0,
      ino: 0,
      mode: Number(value.mode),
      nlink: value.isDirectory ? 2 : 1,
      uid: 1000,
      gid: 1000,
      rdev: 0,
      size: size,
      blksize: 4096,
      blocks: Math.ceil(size / 512),
      atime: mtime,
      mtime: mtime,
      ctime: mtime,
      birthtime: mtime,
      atimeMs: mtime.getTime(),
      mtimeMs: mtime.getTime(),
      ctimeMs: mtime.getTime(),
      birthtimeMs: mtime.getTime()
    };
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
    var result = { name: String(name), parentPath: String(parentPath), path: String(parentPath) };
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
    return bridge('fsStat', follow ? 'stat' : 'lstat', path, [path, !follow]);
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
    if (typeof options === 'string') options = { encoding: options };
    options = options || {};
    var output = [];
    collect(path, '', { recursive: Boolean(options.recursive), withFileTypes: Boolean(options.withFileTypes) }, output);
    if (options.encoding === 'buffer') return output.map(function (entry) {
      return typeof entry === 'string' ? Buffer.from(entry) : entry;
    });
    return output;
  }

  function firstCreated(path) {
    var text = String(path);
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
    try {
      return raw.readFileBuffer(path);
    } catch (error) {
      throw failure(error, 'open', path);
    }
  };
  fs.readFileSync = function (path, options) {
    try {
      return raw.readFileSync(path, options);
    } catch (error) {
      throw failure(error, 'open', path);
    }
  };
  fs.writeFileSync = function (path, data) {
    bridge('fsWrite', 'open', path, [path, bytes(data)]);
  };
  fs.appendFileSync = function (path, data) {
    bridge('fsAppend', 'open', path, [path, bytes(data)]);
  };
  fs.statSync = function (path) {
    return stats(readStats(path, true));
  };
  fs.lstatSync = function (path) {
    return stats(readStats(path, false));
  };
  fs.readdirSync = readdir;
  fs.mkdirSync = function (path, options) {
    var recursive = Boolean(options && typeof options === 'object' && options.recursive);
    var created = recursive ? firstCreated(path) : undefined;
    bridge('fsMkdir', 'mkdir', path, [path, recursive]);
    return created;
  };
  fs.rmSync = function (path, options) {
    bridge('fsRm', 'rm', path, [path, Boolean(options && options.recursive), Boolean(options && options.force)]);
  };
  fs.existsSync = function (path) {
    try {
      return bridge('fsExists', 'access', path, [path]);
    } catch (error) {
      return false;
    }
  };
  fs.symlinkSync = function (target, path) {
    bridge('fsSymlink', 'symlink', path, [target, path]);
  };
  fs.readlinkSync = function (path) {
    return bridge('fsReadlink', 'readlink', path, [path]);
  };
  fs.chmodSync = function (path, mode) {
    bridge('fsChmod', 'chmod', path, [path, Number(mode)]);
  };
  fs.realpathSync = function (path) {
    return bridge('fsRealpath', 'realpath', path, [path]);
  };
  fs.renameSync = function (from, to) {
    bridge('fsRename', 'rename', from, [from, to], to);
  };
  fs.copyFileSync = function (from, to) {
    bridge('fsCopy', 'copyfile', from, [from, to], to);
  };
  fs.unlinkSync = function (path) {
    bridge('fsRm', 'unlink', path, [path, false, false]);
  };
  fs.rmdirSync = function (path, options) {
    bridge('fsRm', 'rmdir', path, [path, Boolean(options && options.recursive), false]);
  };

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
  fs.promises.access = function (path) {
    return new Promise(function (resolve, reject) {
      if (fs.existsSync(path)) resolve();
      else reject(failure(new Error("ENOENT: no such file or directory, access '" + path + "'"), 'access', path));
    });
  };

  globalThis.fs = fs;
})();
`;
