'use strict';
// SharedPreferences 的替代：每个偏好文件对应 userData/prefs/<name>.json，写入时先写临时文件再改名。
const fs = require('fs');
const path = require('path');

class Prefs {
  constructor(dir) {
    this.dir = dir;
    this.cache = new Map();
    fs.mkdirSync(dir, { recursive: true });
  }
  file(name) { return path.join(this.dir, name.replace(/[^A-Za-z0-9_-]/g, '_') + '.json'); }
  all(name) {
    if (this.cache.has(name)) return this.cache.get(name);
    let v = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file(name), 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) v = parsed;
    } catch (e) { /* 文件不存在或损坏：按空处理，与 SharedPreferences 默认一致 */ }
    this.cache.set(name, v);
    return v;
  }
  get(name, key, def) {
    const o = this.all(name);
    return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : def;
  }
  has(name, key) { return Object.prototype.hasOwnProperty.call(this.all(name), key); }
  /** edit(name, fn)：fn 收到可修改的对象副本，返回后原子落盘。 */
  edit(name, fn) {
    const next = { ...this.all(name) };
    fn(next);
    const f = this.file(name);
    const tmp = f + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(next), 'utf8');
    fs.renameSync(tmp, f);
    this.cache.set(name, next);
  }
  put(name, key, value) { this.edit(name, (o) => { o[key] = value; }); }
  remove(name, key) { this.edit(name, (o) => { delete o[key]; }); }
  clear(name) { this.edit(name, (o) => { for (const k of Object.keys(o)) delete o[k]; }); }
}

module.exports = { Prefs };
