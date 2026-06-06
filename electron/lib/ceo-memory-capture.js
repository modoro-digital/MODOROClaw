'use strict';
// Pure CEO-memory capture. NO require of ceo-memory.js / conversation.js / DB.
// All I/O (writeMemory, searchMemory, readExistingMemories, modelCall) is
// dependency-injected so this module is fully unit-testable under plain `node`.
const { call9Router } = require('./nine-router');

// Emittable = types safe to write for source 'auto'. Excludes `task` (writeMemory
// returns {skipped:true} for source 'auto' + 'task', ceo-memory.js:376) and `task_state`
// (excluded by editorial choice — conversational CEO facts aren't task-state), plus any
// non-VALID_TYPES (which _normalizeType THROWS on).
const EMITTABLE = new Set(['rule', 'pattern', 'preference', 'fact', 'correction', 'procedure', 'entity_note']);

function _norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

function _layer1(text) {
  const facts = [];
  // Strip sender prefixes before matching so ^ anchors work on the actual content.
  // Covers: "Anh:", "Em:", "Bot:", "CEO:", "Khách:", "Zalo:", "Telegram:", etc.
  // The colon may or may not be preceded by whitespace.
  const SENDER_STRIP = /^(?:anh|em|bot|ceo|khách|zalo|telegram|facebook|messenger|whatsapp)[\s:]*\s*/i;
  const lines = String(text || '').split(/\r?\n/);
  const PREF = /^(?:anh|em)?\s*(thích|ưa|muốn|chỉ\s*muốn|ghét|không\s*thích|đừng|không\s*được|chớ)\s+(.{3,120})/i;
  const ALWAYS = /^(?:anh|em)?\s*(luôn\s*luôn|lúc\s*nào\s*cũng|bao\s*giờ\s*cũng)\s+(.{3,120})/i;
  const CORR = /(?:^|[^a-zA-ZàáảãạâấầẩẫậăắằẳẵặèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹđÀÁẢÃẠÂẤẦẨẪẬĂẮẰẲẴẶÈÉẺẼẸÊẾỀỂỄỆÌÍỈĨỊÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÙÚỦŨỤƯỨỪỬỮỰỲÝỶỸĐ])(sai\s*rồi|không\s*phải).{0,40}(mà\s*là|phải\s*là)\s+(.{3,120})/i;
  const LATER = /(?:^|[^a-zA-ZàáảãạâấầẩẫậăắằẳẵặèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹđÀÁẢÃẠÂẤẦẨẪẬĂẮẰẲẴẶÈÉẺẼẸÊẾỀỂỄỆÌÍỈĨỊÒÓỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÙÚỦŨỤƯỨỪỬỮỰỲÝỶỸĐ])(lần\s*sau|từ\s*giờ|từ\s*nay)\s+(.{3,120})/i;
  for (const ln of lines) {
    const stripped = ln.replace(SENDER_STRIP, '');
    if (PREF.test(stripped) || ALWAYS.test(stripped)) facts.push({ type: 'preference', content: _norm(ln).slice(0, 200), confidence: 1 });
    else if (CORR.test(ln) || LATER.test(ln)) facts.push({ type: 'correction', content: _norm(ln).slice(0, 200), confidence: 1 });
  }
  return facts;
}

async function captureFromConversation(text, { existingMemories = '', modelCall = call9Router } = {}) {
  const errors = [];
  const facts = _layer1(text);

  // Layer 2: code-triggered LLM extraction (best-effort)
  let raw;
  try {
    const prompt =
      'Trích các thông tin MỚI đáng nhớ về CEO từ hội thoại dưới đây. ' +
      'CHỈ trả JSON array [{"type","content"}]; type ∈ ' + [...EMITTABLE].join('|') + '. ' +
      'Rỗng [] nếu không có gì mới. KHÔNG ghi lại điều đã có.\n\n' +
      '--- ĐÃ NHỚ ---\n' + String(existingMemories).slice(0, 4000) + '\n--- HỘI THOẠI ---\n' + String(text).slice(0, 8000);
    raw = await modelCall(prompt, { maxTokens: 600, temperature: 0.1, timeoutMs: 20000 });
  } catch (e) { errors.push('modelCall: ' + (e && e.message || e)); return { facts: facts.filter(f => EMITTABLE.has(f.type)), errors }; }
  try {
    const m = String(raw || '').match(/\[[\s\S]*\]/); // salvage the JSON array
    if (!m) { errors.push('parse: no JSON array found in model output'); return { facts: facts.filter(f => EMITTABLE.has(f.type)), errors }; }
    const arr = JSON.parse(m[0]);
    for (const it of (Array.isArray(arr) ? arr : [])) {
      const type = String(it && it.type || '').trim();
      const content = _norm(it && it.content).slice(0, 200);
      if (content && EMITTABLE.has(type)) facts.push({ type, content, confidence: 0.7 });
    }
  } catch (e) { errors.push('parse: ' + (e && e.message || e)); }

  return { facts: facts.filter(f => EMITTABLE.has(f.type)), errors };
}

async function captureAndStore(text, deps = {}) {
  const {
    modelCall = call9Router,
    readExistingMemories = async () => '',
    searchMemory,
    writeMemory,
    onMissed = () => {},
  } = deps;
  if (typeof writeMemory !== 'function' || typeof searchMemory !== 'function') throw new Error('captureAndStore: writeMemory/searchMemory required');
  const existingMemories = await readExistingMemories().catch(() => '');
  const { facts, errors } = await captureFromConversation(text, { existingMemories, modelCall });
  let written = 0, skipped = 0, deduped = 0;
  for (const fact of facts) {
    try {
      const hits = await searchMemory(fact.content, { scopes: ['ceo'], limit: 3 }).catch(() => []);
      const dup = (hits || []).some(h => h.type === fact.type && _norm(h.content).toLowerCase() === _norm(fact.content).toLowerCase());
      if (dup) { deduped++; continue; }
      const r = await writeMemory({ type: fact.type, content: fact.content, scope: 'ceo', source: fact.type === 'correction' ? 'ceo_correction' : 'auto' });
      if (r && r.skipped) { skipped++; onMissed({ type: fact.type, content: fact.content, reason: 'skipped' }); }
      else written++;
    } catch (e) { onMissed({ type: fact.type, content: fact.content, error: String(e && e.message || e) }); }
  }
  return { written, skipped, deduped, errors };
}

module.exports = { captureFromConversation, captureAndStore, EMITTABLE, _layer1, _norm };
