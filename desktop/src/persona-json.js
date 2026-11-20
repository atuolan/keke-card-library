'use strict';
// SillyTavern settings.json 的 User 设定读写。
// Java 版用 JsonReader/JsonWriter 把整份文件重写成无缩进格式；桌面版只替换
// power_user.personas / power_user.persona_descriptions 两个值的文本片段，其余内容逐字保留。

function skipWs(s, i) {
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break;
  }
  return i;
}
function skipString(s, i) {
  i++;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 92) { i += 2; continue; }
    if (c === 34) return i + 1;
    i++;
  }
  throw new Error('JSON结构无效');
}
function skipValue(s, i) {
  const c = s[i];
  if (c === '"') return skipString(s, i);
  if (c === '{' || c === '[') {
    let depth = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '"') { i = skipString(s, i); continue; }
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') { depth--; if (depth === 0) return i + 1; }
      i++;
    }
    throw new Error('JSON结构无效');
  }
  while (i < s.length && !/[,\]}\s]/.test(s[i])) i++;
  return i;
}
/** s[start] === '{'：返回对象的成员列表（含值在原文中的起止位置）。调用前文本已通过 JSON.parse 校验。 */
function members(s, start) {
  if (s[start] !== '{') throw new Error('JSON结构无效');
  let i = skipWs(s, start + 1);
  const out = [];
  if (s[i] === '}') return out;
  for (;;) {
    const ks = i;
    i = skipString(s, i);
    const key = JSON.parse(s.slice(ks, i));
    i = skipWs(s, i);
    if (s[i] !== ':') throw new Error('JSON结构无效');
    i = skipWs(s, i + 1);
    const vs = i;
    i = skipValue(s, i);
    out.push({ key, keyStart: ks, valueStart: vs, valueEnd: i });
    i = skipWs(s, i);
    if (s[i] === ',') { i = skipWs(s, i + 1); continue; }
    if (s[i] === '}') return out;
    throw new Error('JSON结构无效');
  }
}

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

function stripBom(text) { return text.charCodeAt(0) === 0xfeff ? { bom: '﻿', text: text.slice(1) } : { bom: '', text }; }

/** 返回 { power_user: { personas?, persona_descriptions? } }，与 Java readPersonaSettings 的 text 内容一致。 */
function extractPersona(raw) {
  const { text } = stripBom(raw);
  const root = JSON.parse(text);
  if (!isObj(root)) throw new Error('Expected BEGIN_OBJECT');
  const power = {};
  if (Object.prototype.hasOwnProperty.call(root, 'power_user')) {
    const pu = root.power_user;
    if (!isObj(pu)) throw new Error('Expected BEGIN_OBJECT');
    for (const k of ['personas', 'persona_descriptions']) {
      if (!Object.prototype.hasOwnProperty.call(pu, k)) continue;
      if (!isObj(pu[k])) throw new Error('JSON结构无效');
      power[k] = pu[k];
    }
  }
  return { power_user: power };
}

function lineIndent(s, pos) {
  const nl = s.lastIndexOf('\n', pos - 1);
  if (nl < 0) return null;
  const m = /^[ \t]*/.exec(s.slice(nl + 1, pos));
  return m ? m[0] : '';
}
function detectUnit(s, rootMembers) {
  if (!rootMembers.length) return null;
  const ind = lineIndent(s, rootMembers[0].keyStart);
  return ind ? ind : null;
}

/** patch: { personas: {...}, persona_descriptions: {...} }，只替换已存在的键（同 Java personaPatch）。 */
function patchPersona(raw, patch) {
  const { bom, text } = stripBom(raw);
  JSON.parse(text); // 先完整校验
  const start = skipWs(text, 0);
  const rootMembers = members(text, start);
  const unit = detectUnit(text, rootMembers);
  const reps = [];
  let found = false;
  for (const m of rootMembers) {
    if (m.key !== 'power_user') continue;
    found = true;
    for (const pm of members(text, m.valueStart)) {
      if (!Object.prototype.hasOwnProperty.call(patch, pm.key)) continue;
      reps.push({ start: pm.valueStart, end: pm.valueEnd, value: patch[pm.key], indent: lineIndent(text, pm.keyStart) });
    }
  }
  if (!found) throw new Error('缺少power_user，停止写回');
  reps.sort((a, b) => b.start - a.start);
  let out = text;
  for (const r of reps) {
    let rendered;
    if (unit == null || r.indent == null) rendered = JSON.stringify(r.value);
    else rendered = JSON.stringify(r.value, null, unit).replace(/\n/g, '\n' + r.indent);
    out = out.slice(0, r.start) + rendered + out.slice(r.end);
  }
  JSON.parse(out); // 写出前再校验一次
  return bom + out;
}

module.exports = { extractPersona, patchPersona, members, isObj };
