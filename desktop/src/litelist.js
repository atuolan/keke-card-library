'use strict';
// fetchCharListLite 的流式解析：对应 Java 的 parseLiteList / writeOneChar。
// 顶层是数组 → 逐个角色对象；顶层是对象 → 取第一个数组类型的值作为角色列表。
// 每个角色只保留字符串类型的 name / avatar / description（description 截断到 120 个 UTF-16 单元）。
const { Tokenizer, TokenType } = require('@streamparser/json');

class LiteListParser {
  constructor(write) {
    this.write = write;          // (text) => void
    this.count = 0;
    this.stack = [];             // 容器栈：{ type: 'obj'|'arr', role, expectKey, key }
    this.root = null;            // 'arr' | 'obj' | 'other'
    this.consumed = false;       // 顶层对象里是否已经用掉了第一个数组
    this.cur = null;             // 正在收集的角色对象
    this.ended = false;
    this.tok = new Tokenizer();
    this.tok.onToken = (t) => this.onToken(t);
    this.tok.onError = (e) => { this.error = e; };
  }
  feed(chunk) {
    if (this.error) throw this.error;
    if (this.ended) return; // 顶层值已结束，Java JsonReader 也不会再读后续内容
    this.tok.write(chunk);
    if (this.error) throw this.error;
  }
  finish() {
    if (this.error) throw this.error;
    if (!this.ended && this.root === null) throw new Error('End of input');
    if (!this.ended) throw new Error('JSON 不完整');
  }
  top() { return this.stack[this.stack.length - 1]; }
  // 当前值在角色列表中的位置角色：'char' 表示这是一个列表元素
  roleForNewValue() {
    const depth = this.stack.length;
    const parent = this.top();
    if (depth === 0) return 'root';
    if (depth === 1 && this.root === 'arr') return 'char';
    if (depth === 2 && this.root === 'obj' && parent.role === 'list') return 'char';
    if (depth === 1 && this.root === 'obj' && parent.type === 'obj') return this.consumed ? 'skip' : 'maybeList';
    if (parent.role === 'charObj' && depth === this.charDepth) return 'charField';
    return 'skip';
  }
  onToken({ token, value }) {
    if (this.ended) return;
    const T = TokenType;
    const parent = this.top();
    // 对象里的键
    if (parent && parent.type === 'obj' && parent.expectKey) {
      if (token === T.STRING) { parent.key = value; return; }
      if (token === T.COLON) { parent.expectKey = false; return; }
      if (token === T.RIGHT_BRACE) { this.closeContainer(); return; }
      return;
    }
    if (token === T.COMMA) { if (parent && parent.type === 'obj') parent.expectKey = true; return; }
    if (token === T.RIGHT_BRACE || token === T.RIGHT_BRACKET) { this.closeContainer(); return; }
    if (token === T.LEFT_BRACE || token === T.LEFT_BRACKET) {
      const role = this.roleForNewValue();
      const type = token === T.LEFT_BRACE ? 'obj' : 'arr';
      const node = { type, expectKey: type === 'obj', key: null, role: 'skip' };
      if (role === 'root') { this.root = type; node.role = 'root'; }
      else if (role === 'maybeList' && type === 'arr') { node.role = 'list'; this.consumed = true; }
      else if (role === 'char' && type === 'obj') { node.role = 'charObj'; this.charDepth = this.stack.length + 1; this.cur = { name: null, avatar: null, description: null }; }
      this.stack.push(node);
      return;
    }
    // 标量
    const role = this.roleForNewValue();
    if (role === 'root') { this.root = 'other'; this.ended = true; return; }
    if (role === 'charField' && token === T.STRING) {
      const k = parent.key;
      if (k === 'name') this.cur.name = value;
      else if (k === 'avatar') this.cur.avatar = value;
      else if (k === 'description') this.cur.description = value.length > 120 ? value.slice(0, 120) : value;
    }
  }
  closeContainer() {
    const node = this.stack.pop();
    if (!this.stack.length) this.ended = true;
    if (node && node.role === 'charObj') {
      const c = this.cur; this.cur = null;
      const s = (v) => JSON.stringify(v == null ? '' : v);
      this.write((this.count > 0 ? ',' : '') + '{"name":' + s(c.name) + ',"avatar":' + s(c.avatar) + ',"description":' + s(c.description) + '}');
      this.count++;
    }
  }
}

module.exports = { LiteListParser };
