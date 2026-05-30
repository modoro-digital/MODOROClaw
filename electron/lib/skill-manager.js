'use strict';
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./util');

function getUserSkillsDir() {
  const { getWorkspace } = require('./workspace');
  const ws = getWorkspace();
  if (!ws) return null;
  return path.join(ws, 'user-skills');
}

function getRegistryPath() {
  const dir = getUserSkillsDir();
  return dir ? path.join(dir, '_registry.json') : null;
}

const _idRe = /^[a-z0-9][a-z0-9-]{0,79}$/;

// 2026-05-15: skill library consolidation — old `appliesTo` paths from
// user-created skills map to the new merged shipped skill paths. Migration
// runs at registry-read time so existing entries don't silently target a
// deleted skill (which would no-op the `appliesTo` filter and the user
// rule would never inject).
const _APPLIESTO_PATH_MIGRATIONS = {
  // Renamed/merged shipped skills (Round 1 consolidation, this session).
  'operations/docx': 'anthropic-docx',
  'operations/pptx': 'anthropic-pptx',
  'operations/excel': 'anthropic-xlsx',
  'operations/xlsx': 'anthropic-xlsx',
  'operations/pdf': 'anthropic-pdf',
  'pptx-generator': 'anthropic-pptx',
  'operations/zalo-reply-rules': 'operations/zalo',
  'operations/zalo-customer-care': 'operations/zalo',
  'operations/zalo-group': 'operations/zalo',
  'operations/facebook-image': 'operations/image-generation',
  'operations/send-zalo': 'operations/telegram-ceo',
  // ALSO map skills that were ARCHIVED (moved to skills/_archived/) so that
  // user-skills scoped to them don't become silent orphans. Empty string =
  // "no scope" = applies everywhere (standalone) — safer than scoping to a
  // skill that no longer exists where the rule would NEVER fire.
  // Archived content/finance/strategy/advisory/etc. families:
  'content/brand-guidelines': '',
  'content/content-humanizer': '',
  'content/content-production': '',
  'content/content-creator': '',
  'content/content-strategist': '',
  'content/social-media-analyzer': '',
  'content/social-media-manager': '',
  'content/video-content-strategist': '',
  'content/x-twitter-growth': '',
  'finance/finance-bundle': '',
  'finance/finance-lead': '',
  'finance/soc2-compliance': '',
  'strategy/change-management': '',
  'strategy/board-deck-builder': '',
  'strategy/board-meeting': '',
  'strategy/board-prep': '',
  'strategy/board': '',
  'strategy/business-growth-bundle': '',
  'strategy/launch-strategy': '',
  'strategy/marketing-strategy-pmm': '',
  'strategy/pricing-strategy': '',
  // Archived marketing sub-skills (kept zalo-post-workflow only)
  'marketing/copywriting': '',
  'marketing/copy-editing': '',
  'marketing/email-sequence': '',
  'marketing/launch-strategy': '',
  'marketing/paid-ads': '',
  'marketing/pricing-strategy': '',
  'marketing/social-content': '',
  'marketing/content-strategy': '',
  'marketing/ab-test-setup': '',
  'marketing/ad-creative': '',
  'marketing/ai-seo': '',
  'marketing/analytics-tracking': '',
  'marketing/churn-prevention': '',
  'marketing/cold-email': '',
  'marketing/community-marketing': '',
  'marketing/competitor-alternatives': '',
  'marketing/customer-research': '',
  'marketing/form-cro': '',
  'marketing/free-tool-strategy': '',
  'marketing/lead-magnets': '',
  'marketing/marketing-ideas': '',
  'marketing/marketing-psychology': '',
  'marketing/onboarding-cro': '',
  'marketing/page-cro': '',
  'marketing/paywall-upgrade-cro': '',
  'marketing/popup-cro': '',
  'marketing/product-marketing-context': '',
  'marketing/programmatic-seo': '',
  'marketing/referral-program': '',
  'marketing/revops': '',
  'marketing/sales-enablement': '',
  'marketing/schema-markup': '',
  'marketing/seo-audit': '',
  'marketing/signup-flow-cro': '',
  'marketing/site-architecture': '',
  // Archived advisory / sales / growth / hr
  'advisory/business-investment-advisor': '',
  'advisory/c-level-advisor-main': '',
  'advisory/ceo-advisor': '',
  'advisory/cfo-advisor': '',
  'advisory/chro-advisor': '',
  'advisory/ciso-advisor': '',
  'advisory/cmo-advisor': '',
  'advisory/coo-advisor': '',
  'advisory/cpo-advisor': '',
  'advisory/cro-advisor': '',
  'advisory/cto-advisor': '',
  'sales/cold-email': '',
  'sales/customer-success-manager': '',
  'sales/referral-program': '',
  'sales/revenue-operations': '',
  'sales/sales-engineer': '',
  'growth/campaign-analytics': '',
  'growth/email-template-builder': '',
  'growth/growth-marketer': '',
  'growth/marketing-demand-acquisition': '',
  'growth/marketing-ops': '',
  'hr/change-management': '',
  'hr/chro-advisor': '',
};

const _LEGACY_SHIPPED_SKILL_PATHS = new Set([
  'operations/docx',
  'operations/pptx',
  'operations/excel',
  'operations/xlsx',
  'operations/pdf',
  'pptx-generator',
]);

function _canonicalShippedSkillPath(relPath) {
  return _APPLIESTO_PATH_MIGRATIONS[relPath] || relPath;
}

function _migrateAppliesTo(arr) {
  if (!Array.isArray(arr)) return [];
  const remapped = arr
    .filter(x => typeof x === 'string')
    .map(x => x in _APPLIESTO_PATH_MIGRATIONS ? _APPLIESTO_PATH_MIGRATIONS[x] : x)
    // Empty-string mapping = "drop this scope" (skill becomes standalone for
    // this entry). Archived-skill paths map to '' so user-skills scoped to
    // them don't silently become orphan no-ops after upgrade — they fall
    // back to applying everywhere, which is safer than never applying.
    .filter(x => x !== '');
  // Dedupe — multiple old refs may collapse to the same new path
  // (e.g. zalo-reply-rules + zalo-customer-care both → zalo).
  return [...new Set(remapped)];
}

function _sanitizeRegistry(raw) {
  if (!raw || typeof raw !== 'object') return { version: 1, skills: [] };
  const skills = Array.isArray(raw.skills) ? raw.skills : [];
  const clean = [];
  const seen = new Set();
  for (const s of skills) {
    if (!s || typeof s !== 'object') continue;
    if (typeof s.id !== 'string' || !_idRe.test(s.id)) continue;
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    const scripts = Array.isArray(s.scripts) ? s.scripts.filter(x => x && typeof x === 'object' && typeof x.filename === 'string').map(x => ({
      name: typeof x.name === 'string' ? x.name : x.filename.replace(/\.[^.]+$/, ''),
      filename: x.filename,
      runtime: typeof x.runtime === 'string' ? x.runtime : 'python',
      description: typeof x.description === 'string' ? x.description : '',
    })) : [];
    clean.push({
      id: s.id,
      name: typeof s.name === 'string' ? s.name : s.id,
      type: typeof s.type === 'string' ? s.type : 'custom',
      appliesTo: _migrateAppliesTo(s.appliesTo),
      trigger: typeof s.trigger === 'string' ? s.trigger : '',
      summary: typeof s.summary === 'string' ? s.summary : '',
      enabled: s.enabled !== false,
      createdAt: typeof s.createdAt === 'string' ? s.createdAt : new Date().toISOString(),
      createdVia: typeof s.createdVia === 'string' ? s.createdVia : 'unknown',
      layout: s.layout === 'folder' ? 'folder' : 'flat',
      scripts,
    });
  }
  return { version: 1, skills: clean };
}

function readRegistry() {
  const p = getRegistryPath();
  if (!p) return { version: 1, skills: [] };
  try {
    return _sanitizeRegistry(JSON.parse(fs.readFileSync(p, 'utf-8')));
  } catch (e) {
    if (e.code === 'ENOENT') return { version: 1, skills: [] };
    const dir = path.dirname(p);
    if (fs.existsSync(dir)) {
      const tmps = fs.readdirSync(dir).filter(f => f.startsWith('_registry.json.tmp.'));
      for (const tmp of tmps.sort().reverse()) {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(dir, tmp), 'utf-8'));
          const recovered = _sanitizeRegistry(raw);
          writeJsonAtomic(p, recovered);
          console.warn('[skill-manager] recovered registry from', tmp);
          try { fs.unlinkSync(path.join(dir, tmp)); } catch {}
          return recovered;
        } catch {}
      }
    }
    console.error('[skill-manager] registry corrupt:', e.message);
    try {
      const logDir = path.join(path.dirname(dir), 'logs');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(path.join(logDir, 'skill-errors.log'),
        `${new Date().toISOString()} registry corrupt: ${e.message}\n`, 'utf-8');
    } catch {}
    return { version: 1, skills: [] };
  }
}

// G-I2 fix 2026-05-15: persist the appliesTo migration the first time the
// registry is read at boot, so subsequent readers don't pay the remap cost
// AND so the on-disk file reflects current shipped-skill names (helpful for
// manual debugging via `cat _registry.json`). Idempotent: only writes when
// at least one entry's appliesTo actually changed.
let _migrationPersistedThisBoot = false;
function persistAppliesToMigrationIfNeeded() {
  if (_migrationPersistedThisBoot) return false;
  const p = getRegistryPath();
  if (!p || !fs.existsSync(p)) { _migrationPersistedThisBoot = true; return false; }
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!raw || !Array.isArray(raw.skills)) { _migrationPersistedThisBoot = true; return false; }
    let changed = false;
    for (const s of raw.skills) {
      if (!Array.isArray(s.appliesTo)) continue;
      const before = JSON.stringify(s.appliesTo);
      const after = _migrateAppliesTo(s.appliesTo);
      if (JSON.stringify(after) !== before) { s.appliesTo = after; changed = true; }
    }
    if (changed) {
      writeJsonAtomic(p, raw);
      console.log('[skill-manager] persisted appliesTo migration to disk');
    }
    _migrationPersistedThisBoot = true;
    return changed;
  } catch (e) {
    console.warn('[skill-manager] persistAppliesToMigrationIfNeeded failed:', e?.message);
    _migrationPersistedThisBoot = true;
    return false;
  }
}

function writeRegistry(registry) {
  const p = getRegistryPath();
  if (!p) return;
  writeJsonAtomic(p, registry);
  // NOTE: INLINE.md regen is called by each mutation AFTER the .md file is in
  // correct state (created/updated/deleted/restored). Calling here would race
  // because createUserSkill writes registry BEFORE the .md file exists, which
  // makes _regenerateInlineFile fall back to the truncated 120-char summary.
}

// Lazy-load architecture: skills are read on-demand by inbound.ts and the
// Telegram CEO handler each turn, filtered by trigger-keyword matching against the current message.
// No more INLINE.md eager-merge — saves context budget and avoids irrelevant
// rules polluting the agent's attention.
//
// Stop words common in Vietnamese (and Latin'd forms) — filtered out of trigger
// matching to avoid false positives. Pronouns, particles, conditionals, fillers.
const _SKILL_STOP_WORDS = new Set([
  // conditionals + connectives
  'khi','neu','la','va','co','khong','thi','cua','cho','vao','voi','tu','den','ma','rat','qua',
  // pronouns + addresses
  'toi','con','anh','em','chi','minh','ban','no','ho','ta','may','tao',
  // particles + fillers
  'ay','do','ne','nha','ah','oi','nhi','sao','vay','the','day','kia','thoi','nua','them','gi','nao','ca','hay','cung',
  // common adverbs/locatives
  'luc','tren','duoi','trong','ngoai','sau','truoc','roi','ra','di','lai','xuong','len','ve',
  // generic verbs/objects
  'cac','mot','de','duoc','lam','muon','can',
  // time fillers
  'hom','nay','gio',
]);

function _norm(s) {
  // ̀-ͯ covers the entire Unicode "Combining Diacritical Marks"
  // block. Using explicit codepoints instead of literal combining marks
  // (which can be invisible in source / stripped by some editors) makes the
  // regex deterministic regardless of how this file is opened/saved.
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd');
}

function _tokenize(s) {
  return _norm(s).split(/[^\w]+/).filter(Boolean).filter(w => !_SKILL_STOP_WORDS.has(w));
}

// Match a single skill trigger against the rawBody. Uses 2 strategies that
// AVOID substring false positives (e.g. "kho" matching inside "khong"):
//   1. Specific token match: any trigger word with length >= 4 must appear
//      as a STANDALONE token in body (word boundary).
//   2. Bigram match: any 2-word phrase from trigger must appear as a
//      consecutive bigram in body. Catches Vietnamese compounds like
//      "báo cáo", "tồn kho", "đổi trả" that work as phrase, not single word.
function _shouldApplySkill(skill, body, bodyTokens, bodyBigrams) {
  const trigger = _norm(skill.trigger || '').trim();
  if (!trigger) return true;
  if (/^(luon|always|moi)\b/.test(trigger)) return true;

  const triggerTokens = _tokenize(trigger);
  if (triggerTokens.length === 0) return true; // trigger was all stops

  const triggerSpecific = triggerTokens.filter(w => w.length >= 4);
  for (const sw of triggerSpecific) {
    if (bodyTokens.has(sw)) return true;
  }

  const triggerBigrams = [];
  for (let i = 0; i < triggerTokens.length - 1; i++) {
    triggerBigrams.push(triggerTokens[i] + ' ' + triggerTokens[i + 1]);
  }
  for (const bg of triggerBigrams) {
    if (bodyBigrams.has(bg)) return true;
  }
  return false;
}

// Return matched skills for the given message body. Used by inbound.ts +
// chat.js to inject ONLY relevant skill content into rawBody/prompt.
//
// Optional `opts.scope` is the current routing context ID — when set, only
// skills whose `appliesTo` is empty (standalone, applies everywhere) OR
// includes the scope are eligible. Round-2 reviewer 2026-05-15 found
// `appliesTo` was previously stored but NEVER consulted at match time —
// scoping was cosmetic. Now: pass `{ scope: 'operations/zalo' }` from
// inbound.ts (Zalo channel), `{ scope: 'operations/telegram-ceo' }` from
// the Telegram CEO handler, etc. Omitted scope = legacy behavior (no filter).
function matchActiveSkills(rawBody, opts = {}) {
  const registry = readRegistry();
  const active = (registry?.skills || []).filter(s => s && s.enabled !== false);
  if (active.length === 0) return [];
  const scope = typeof opts.scope === 'string' && opts.scope ? opts.scope : null;

  // Precompute body tokens + bigrams once for all skills.
  const tokensArr = _tokenize(rawBody);
  const bodyTokens = new Set(tokensArr);
  const bodyBigrams = new Set();
  for (let i = 0; i < tokensArr.length - 1; i++) {
    bodyBigrams.add(tokensArr[i] + ' ' + tokensArr[i + 1]);
  }
  const body = _norm(rawBody);

  const matched = [];
  for (const skill of active) {
    // Scope filter — only apply if caller passed a scope. Skills with empty
    // appliesTo are standalone and match every scope.
    if (scope) {
      const at = Array.isArray(skill.appliesTo) ? skill.appliesTo : [];
      if (at.length > 0 && !at.includes(scope)) continue;
    }
    if (_shouldApplySkill(skill, body, bodyTokens, bodyBigrams)) matched.push(skill);
  }
  return matched;
}

// Read full skill content from disk for an entry. Supports both flat
// `<id>.md` (legacy) and `<id>/SKILL.md` (Anthropic folder layout).
// For Anthropic SKILL.md: strip frontmatter, return whole body.
// For legacy flat .md: extract "## Nội dung" section.
function getSkillContent(skill) {
  if (!skill || !skill.id) return '';
  const skillPath = resolveUserSkillContentPath(skill.id);
  if (!skillPath) return skill.summary || '';
  try {
    const raw = fs.readFileSync(skillPath, 'utf-8');
    // Anthropic SKILL.md: skip YAML frontmatter (--- ... ---), return body
    if (skillPath.endsWith('SKILL.md')) {
      const m = raw.match(/^---\n[\s\S]+?\n---\n([\s\S]+)$/);
      return (m ? m[1] : raw).trim();
    }
    // Legacy flat .md: extract "## Nội dung" section
    const m = raw.match(/## Nội dung\s*\n([\s\S]+?)(?:\n##|\n*$)/);
    return m ? m[1].trim() : (skill.summary || '');
  } catch { return skill.summary || ''; }
}

// Build the <active-user-skills> block injected into agent prompts.
// Returns null if no skills match (caller should not inject anything).
function buildSkillInjectionBlock(rawBody, opts) {
  const matched = matchActiveSkills(rawBody, opts);
  if (matched.length === 0) return null;
  const blocks = matched.map(skill => {
    const content = getSkillContent(skill);
    const trigger = (skill.trigger || '').trim() || 'luôn luôn';
    return `[${skill.name}] (khi: ${trigger})\n${content}`;
  });
  let block = blocks.join('\n\n');
  if (block && block.length > 5000) {
    block = block.slice(0, 5000) + '\n[... skill content truncated at 5KB]';
  }
  return block;
}

// Backward-compat no-op. INLINE.md is no longer regenerated; lazy match is
// used instead. Kept exported so workspace.js boot path doesn't error.
function _safeRegenInline() { return null; }

let _skillWriteChain = Promise.resolve();
async function withSkillLock(fn) {
  let release;
  const gate = new Promise(r => { release = r; });
  const prev = _skillWriteChain;
  _skillWriteChain = gate;
  await prev;
  try { return await fn(); } finally { release(); }
}

function slugify(name) {
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // combining marks (see _norm)
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || ('skill-' + Date.now());
}

function getShippedSkillIds() {
  const { getWorkspace } = require('./workspace');
  const ws = getWorkspace();
  if (!ws) return new Set();
  const skillsDir = path.join(ws, 'skills');
  const ids = new Set();
  function scan(dir, prefix) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '_archived') continue;
      const childPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const relId = (prefix ? prefix + '/' : '') + entry.name;
        if (_LEGACY_SHIPPED_SKILL_PATHS.has(relId)) continue;
        // Anthropic folder skill: has SKILL.md at root → treat dir as single skill.
        if (fs.existsSync(path.join(childPath, 'SKILL.md'))) {
          ids.add(relId);
          continue; // do NOT recurse into scripts/, references/, etc.
        }
        // Otherwise treat as category — recurse.
        scan(childPath, relId);
      } else if (entry.name.endsWith('.md')) {
        ids.add((prefix ? prefix + '/' : '') + entry.name.replace(/\.md$/, ''));
      }
    }
  }
  scan(skillsDir, '');
  return ids;
}

function validateNoCollision(id) {
  const shipped = getShippedSkillIds();
  if (shipped.has(id)) return `Skill id "${id}" conflicts with a shipped skill. Choose a different name.`;
  for (const s of shipped) {
    if (s.endsWith('/' + id)) return `Skill id "${id}" conflicts with shipped skill "${s}". Choose a different name.`;
  }
  return null;
}

// 10000 chars — ngang ngửa shipped skill (lớn nhất ~13KB như
// marketing/zalo-post-workflow.md). CEO viết rule custom cũng cần
// room rộng cho multi-strategy + edge cases + escalation flows.
// Với lazy match architecture, mỗi turn chỉ inject skill match trigger
// (typical 1-2 skill × 10KB = 20KB max) — không blow context budget.
const SKILL_CONTENT_MAX = 10000;

function sanitizeContent(raw) {
  return String(raw || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^#+\s/gm, '')
    // SECURITY: strip prompt-injection markers. Skill content is loaded into
    // agent context (via INLINE.md) so attacker-supplied tags that mimic
    // system blocks could fake authority. Block known tag names + bracketed
    // system-style headers.
    .replace(/<\/?active-user-skills[^>]*>/gi, '')
    .replace(/<\/?(system|kb-doc|ceo|admin|instruction|hệ thống|hethong)[^>]*>/gi, '')
    .replace(/^\s*\[(?:SYSTEM|HỆ THỐNG|CEO|ADMIN|INSTRUCTION|TOOL)[^\]]*\]/gim, '')
    .slice(0, SKILL_CONTENT_MAX);
}

// Loud-fail check used at API entry — does NOT modify the content, just reports
// whether the raw content exceeds the limit so the API can reject with 413.
function isContentTooLong(raw) {
  return String(raw || '').length > SKILL_CONTENT_MAX;
}

function safeUserSkillPath(id) {
  const dir = getUserSkillsDir();
  if (!dir) throw new Error('Workspace not available');
  const target = path.resolve(dir, id + '.md');
  if (!target.startsWith(dir + path.sep)) throw new Error(`Invalid skill id "${id}".`);
  return { dir, target };
}

// Anthropic-style folder path: user-skills/<id>/SKILL.md (+ scripts/, references/).
// Returns null if id invalid. Used by createUserSkill when scripts are present
// and by lookup helpers that must support BOTH flat .md and folder layouts.
function safeUserSkillFolder(id) {
  const dir = getUserSkillsDir();
  if (!dir) return null;
  const folder = path.resolve(dir, id);
  if (!folder.startsWith(dir + path.sep)) return null;
  return { dir, folder, skillMd: path.join(folder, 'SKILL.md') };
}

// Resolve where a user skill's content lives. Checks folder pattern first
// (Anthropic standard) then falls back to flat .md (legacy). Returns null
// if neither exists.
function resolveUserSkillContentPath(id) {
  const folder = safeUserSkillFolder(id);
  if (folder && fs.existsSync(folder.skillMd)) return folder.skillMd;
  const flat = safeUserSkillPath(id);
  if (fs.existsSync(flat.target)) return flat.target;
  return null;
}

function _auditSkill(event, meta) {
  try { require('./workspace').auditLog(event, meta); } catch {}
}

// Escape a string for use as a YAML scalar value. Returns a double-quoted
// string with internal `"`, `\`, newline, CR, and tab properly escaped. Always
// quote — prevents `---`/`*`/`&`/`#` first-character ambiguity AND prevents
// CEO-provided text from breaking out of the frontmatter block (e.g. via a
// literal `\n---\n` injecting bogus YAML fields downstream).
function _yamlEscape(raw) {
  return '"' + String(raw == null ? '' : raw)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t') + '"';
}

// Build Anthropic-style SKILL.md (frontmatter + body).
function _buildAnthropicSkillMd({ name, description, trigger, content, scripts, allowedTools }) {
  const fmLines = ['---'];
  fmLines.push('name: ' + slugify(name));
  if (description) fmLines.push('description: ' + _yamlEscape(description));
  if (Array.isArray(allowedTools) && allowedTools.length) {
    fmLines.push('allowed-tools: [' + allowedTools.map(t => _yamlEscape(t)).join(', ') + ']');
  }
  if (Array.isArray(scripts) && scripts.length) {
    fmLines.push('scripts:');
    for (const s of scripts) {
      const scriptName = s.name || s.filename.replace(/\.[^.]+$/, '');
      fmLines.push(`  - name: ${_yamlEscape(scriptName)}`);
      // Persist the actual filename. Without this, restoreUserSkill has to
      // reconstruct it from name + runtime (e.g. "helper" + ".py") which
      // mangles original filenames like "my_helper.py" — exec-by-filename
      // lookup then fails. Required for round-trip fidelity.
      if (s.filename) fmLines.push(`    filename: ${_yamlEscape(s.filename)}`);
      fmLines.push(`    runtime: ${_yamlEscape(s.runtime || 'python')}`);
      if (s.description) fmLines.push(`    description: ${_yamlEscape(s.description)}`);
      if (Array.isArray(s.args)) fmLines.push(`    args: [${s.args.map(a => _yamlEscape(a)).join(', ')}]`);
    }
  }
  fmLines.push('---', '');
  const safeName = String(name).replace(/^#+\s/gm, '').replace(/\n/g, ' ');
  const safeTrigger = String(trigger || '').replace(/^#+\s/gm, '');
  const body = `# ${safeName}\n\n## Khi nào áp dụng\n${safeTrigger}\n\n## Nội dung\n${content}\n`;
  return fmLines.join('\n') + body;
}

async function createUserSkill({ name, type, appliesTo, trigger, content, createdVia, scripts, allowedTools, description }) {
  return withSkillLock(async () => {
    const registry = readRegistry();
    if (registry.skills.length >= 100) throw new Error('Too many skills (max 100). Delete some first.');

    const id = slugify(name);
    const collision = validateNoCollision(id);
    if (collision) throw new Error(collision);
    if (registry.skills.find(s => s.id === id)) throw new Error(`Skill "${id}" already exists.`);

    const sanitized = sanitizeContent(content);
    const hasScripts = Array.isArray(scripts) && scripts.length > 0;

    // Anthropic folder layout for skills with scripts; legacy flat .md otherwise.
    // Legacy path lets existing user skills (.md only) keep working unchanged.
    let writeTargets = []; // [{path, content}]
    if (hasScripts) {
      const folderInfo = safeUserSkillFolder(id);
      if (!folderInfo) throw new Error(`Invalid skill id "${id}".`);
      const skillMd = _buildAnthropicSkillMd({ name, description: description || trigger, trigger, content: sanitized, scripts, allowedTools });
      writeTargets.push({ path: folderInfo.skillMd, content: skillMd });
      for (const s of scripts) {
        if (!s.filename || !s.code) continue;
        // Validate filename — alphanumeric + underscore/dash, extension only
        if (!/^[a-z0-9_-]+\.(py|js|sh|ps1)$/i.test(s.filename)) {
          throw new Error(`Invalid script filename "${s.filename}". Use lowercase a-z, 0-9, _, - and .py/.js/.sh/.ps1 extension.`);
        }
        const scriptPath = path.join(folderInfo.folder, 'scripts', s.filename);
        writeTargets.push({ path: scriptPath, content: String(s.code) });
      }
    } else {
      const { target } = safeUserSkillPath(id);
      const mdContent = `# ${String(name).replace(/^#+\s/gm, '')}\n\n## Khi nào áp dụng\n${String(trigger || '').replace(/^#+\s/gm, '')}\n\n## Nội dung\n${sanitized}\n`;
      writeTargets.push({ path: target, content: mdContent });
    }

    const entry = {
      id,
      name: String(name),
      type: type || 'custom',
      appliesTo: Array.isArray(appliesTo) ? appliesTo : [],
      trigger: String(trigger || ''),
      summary: sanitized.slice(0, 120),
      enabled: true,
      createdAt: new Date().toISOString(),
      createdVia: createdVia || 'telegram-chat',
      layout: hasScripts ? 'folder' : 'flat',
      scripts: hasScripts ? scripts.map(s => ({ name: s.name || s.filename.replace(/\.[^.]+$/, ''), filename: s.filename, runtime: s.runtime || 'python', description: s.description || '' })) : [],
    };

    // Write registry FIRST. If it fails, no orphan files.
    registry.skills.push(entry);
    writeRegistry(registry);
    try {
      for (const t of writeTargets) {
        try { fs.mkdirSync(path.dirname(t.path), { recursive: true }); } catch {}
        fs.writeFileSync(t.path, t.content, 'utf-8');
      }
    } catch (e) {
      registry.skills.pop();
      try { writeRegistry(registry); } catch {}
      // Cleanup partial files AND parent folder (folder-layout skills).
      // Without the rmSync, a half-written `<id>/scripts/<file>` stays on
      // disk; next retry would see `safeUserSkillFolder(id)` returning an
      // already-existing folder and writeFileSync would succeed but leave
      // unrelated half-written scripts from the previous failed run.
      for (const t of writeTargets) {
        try { fs.unlinkSync(t.path); } catch {}
      }
      if (hasScripts) {
        try {
          const folderInfo = safeUserSkillFolder(id);
          if (folderInfo) fs.rmSync(folderInfo.folder, { recursive: true, force: true });
        } catch {}
      }
      throw new Error(`Failed to write skill files: ${e.message}`);
    }
    _auditSkill('user_skill_created', {
      id, name: entry.name, type: entry.type, createdVia: entry.createdVia,
      layout: entry.layout, scriptCount: entry.scripts.length,
    });
    return entry;
  });
}

async function updateUserSkill(id, updates) {
  return withSkillLock(async () => {
    const registry = readRegistry();
    const idx = registry.skills.findIndex(s => s.id === id);
    if (idx === -1) throw new Error(`Skill "${id}" not found.`);

    const skill = registry.skills[idx];
    const changed = [];
    if (updates.name !== undefined) { skill.name = String(updates.name); changed.push('name'); }
    if (updates.type !== undefined) { skill.type = updates.type; changed.push('type'); }
    if (updates.appliesTo !== undefined) { skill.appliesTo = Array.isArray(updates.appliesTo) ? updates.appliesTo : []; changed.push('appliesTo'); }
    if (updates.trigger !== undefined) { skill.trigger = String(updates.trigger); changed.push('trigger'); }

    if (updates.content !== undefined) {
      const sanitized = sanitizeContent(updates.content);
      // Folder-layout skills (Anthropic format) live at <id>/SKILL.md with
      // YAML frontmatter; flat skills at <id>.md. Writing to the wrong path
      // creates an orphan that resolveUserSkillContentPath silently ignores
      // (it prefers the folder), so the edit would be lost. Branch on layout.
      if (skill.layout === 'folder') {
        const folderInfo = safeUserSkillFolder(id);
        if (!folderInfo) throw new Error(`Invalid skill id "${id}".`);
        const skillMd = _buildAnthropicSkillMd({
          name: skill.name,
          description: updates.description !== undefined ? updates.description : skill.trigger,
          trigger: skill.trigger,
          content: sanitized,
          scripts: skill.scripts,
          allowedTools: skill.allowedTools,
        });
        try { fs.mkdirSync(folderInfo.folder, { recursive: true }); } catch {}
        fs.writeFileSync(folderInfo.skillMd, skillMd, 'utf-8');
      } else {
        const { target } = safeUserSkillPath(id);
        const mdContent = `# ${skill.name}\n\n## Khi nào áp dụng\n${skill.trigger}\n\n## Nội dung\n${sanitized}\n`;
        fs.writeFileSync(target, mdContent, 'utf-8');
      }
      skill.summary = sanitized.slice(0, 120);
      changed.push('content');
    }
    writeRegistry(registry);
    _safeRegenInline();
    _auditSkill('user_skill_updated', { id, fieldsChanged: changed });
    return skill;
  });
}

function _trashPath(id) {
  const dir = getUserSkillsDir();
  if (!dir) return null;
  const trashDir = path.join(dir, '_trash');
  try { if (!fs.existsSync(trashDir)) fs.mkdirSync(trashDir, { recursive: true }); } catch {}
  return path.join(trashDir, `${id}-${Date.now()}.md`);
}

function _pruneOldTrash() {
  try {
    const dir = getUserSkillsDir();
    if (!dir) return;
    const trashDir = path.join(dir, '_trash');
    if (!fs.existsSync(trashDir)) return;
    // Count BOTH flat `.md` files AND folder-layout dirs. Without this,
    // folder soft-deletes accumulated indefinitely (the old filter only
    // matched .md). The 20-entry cap now correctly enforces the documented
    // "20 last deletes" retention regardless of skill layout.
    const entries = fs.readdirSync(trashDir, { withFileTypes: true })
      .map(d => {
        try {
          const full = path.join(trashDir, d.name);
          const st = fs.statSync(full);
          return { name: d.name, full, time: st.mtimeMs, isDir: d.isDirectory() };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.time - a.time);
    for (const e of entries.slice(20)) {
      try {
        if (e.isDir) fs.rmSync(e.full, { recursive: true, force: true });
        else fs.unlinkSync(e.full);
      } catch {}
    }
  } catch {}
}

async function deleteUserSkill(id) {
  return withSkillLock(async () => {
    const registry = readRegistry();
    const idx = registry.skills.findIndex(s => s.id === id);
    if (idx === -1) throw new Error(`Skill "${id}" not found.`);
    const removed = registry.skills.splice(idx, 1)[0];
    writeRegistry(registry);
    // Soft-delete: move source (flat .md OR folder) to _trash for restore.
    try {
      const folderInfo = safeUserSkillFolder(id);
      const flatInfo = safeUserSkillPath(id);
      const trashBase = _trashPath(id).replace(/\.md$/, ''); // _trash/<id>-<ts>
      if (folderInfo && fs.existsSync(folderInfo.folder)) {
        // Folder layout — move whole dir
        try { fs.renameSync(folderInfo.folder, trashBase); }
        catch { try { _copyDirRecursive(folderInfo.folder, trashBase); fs.rmSync(folderInfo.folder, { recursive: true, force: true }); } catch {} }
      } else if (fs.existsSync(flatInfo.target)) {
        // Flat .md — move single file
        try { fs.renameSync(flatInfo.target, trashBase + '.md'); }
        catch { try { fs.copyFileSync(flatInfo.target, trashBase + '.md'); fs.unlinkSync(flatInfo.target); } catch {} }
      }
      _pruneOldTrash();
    } catch {}
    _safeRegenInline();
    _auditSkill('user_skill_deleted', { id, name: removed?.name, layout: removed?.layout || 'flat' });
    return { deleted: id, restorable: true };
  });
}

// Recursive dir copy helper (Node 16+ has fs.cpSync but Electron Node may vary).
function _copyDirRecursive(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) _copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function restoreUserSkill(id) {
  return withSkillLock(async () => {
    const dir = getUserSkillsDir();
    if (!dir) throw new Error('Workspace not available');
    const trashDir = path.join(dir, '_trash');
    if (!fs.existsSync(trashDir)) throw new Error(`No trash directory.`);

    // Find newest trash entry matching `<id>-<ts>` for BOTH layouts:
    //   - flat:   <id>-<ts>.md   (single file)
    //   - folder: <id>-<ts>      (whole directory with SKILL.md + scripts/)
    // The original filter only matched `.md` files → folder-layout skills
    // were unrestorable. This walks dirents and picks the newest match.
    const prefix = id + '-';
    const candidates = [];
    for (const d of fs.readdirSync(trashDir, { withFileTypes: true })) {
      if (!d.name.startsWith(prefix)) continue;
      try {
        const full = path.join(trashDir, d.name);
        const st = fs.statSync(full);
        const isFolder = d.isDirectory();
        const isFlat = !isFolder && d.name.endsWith('.md');
        if (!isFolder && !isFlat) continue;
        // Bare folder name `<id>-<ts>` (no .md) OR flat `<id>-<ts>.md`.
        if (isFolder && d.name.endsWith('.md')) continue;
        candidates.push({ name: d.name, full, time: st.mtimeMs, isFolder });
      } catch {}
    }
    candidates.sort((a, b) => b.time - a.time);
    if (candidates.length === 0) throw new Error(`No deleted backup for "${id}".`);

    const registry = readRegistry();
    if (registry.skills.find(s => s.id === id)) throw new Error(`Skill "${id}" already exists — cannot restore.`);

    const newest = candidates[0];
    let name = id, trigger = '', restoredContent = '', layout = 'flat', scripts = [];
    if (newest.isFolder) {
      // Folder restore: move whole dir back. Parse SKILL.md frontmatter for
      // metadata; preserve scripts list from registry-shape (re-read frontmatter).
      const folderInfo = safeUserSkillFolder(id);
      if (!folderInfo) throw new Error(`Invalid skill id "${id}".`);
      // Read SKILL.md from trash before moving (for registry rebuild).
      const trashSkillMd = path.join(newest.full, 'SKILL.md');
      if (fs.existsSync(trashSkillMd)) {
        const raw = fs.readFileSync(trashSkillMd, 'utf-8');
        const fmMatch = raw.match(/^---\n([\s\S]+?)\n---\n([\s\S]+)$/);
        const fmBlock = fmMatch ? fmMatch[1] : '';
        const body = fmMatch ? fmMatch[2] : raw;
        const nameM = body.match(/^# (.+?)$/m);
        if (nameM) name = nameM[1].trim();
        const trigM = body.match(/## Khi nào áp dụng\s*\n([\s\S]+?)(?:\n##|\n*$)/);
        if (trigM) trigger = trigM[1].trim();
        const contentM = body.match(/## Nội dung\s*\n([\s\S]+?)(?:\n##|\n*$)/);
        if (contentM) restoredContent = contentM[1].trim();
        // Parse scripts list from YAML. Walk line-by-line within `scripts:` block
        // so we capture the optional `filename:` field that newer SKILL.md files
        // emit; fall back to reconstructing `name.runtime-ext` for legacy entries
        // that pre-date the filename-persistence fix (2026-05-15).
        const lines = fmBlock.split('\n');
        let inScripts = false, cur = null;
        const unquote = (v) => v.replace(/^"|"$/g, '').replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
        const flushCur = () => {
          if (!cur) return;
          if (!cur.filename) {
            const ext = cur.runtime === 'python' ? 'py' : (cur.runtime === 'node' ? 'js' : cur.runtime === 'powershell' ? 'ps1' : cur.runtime === 'bash' ? 'sh' : cur.runtime);
            cur.filename = (cur.name || 'script') + '.' + ext;
          }
          scripts.push(cur);
          cur = null;
        };
        for (const ln of lines) {
          if (/^scripts:\s*$/.test(ln)) { inScripts = true; continue; }
          if (inScripts && /^\S/.test(ln) && !/^\s*-/.test(ln)) { flushCur(); inScripts = false; continue; }
          if (!inScripts) continue;
          const newItem = ln.match(/^\s*-\s+name:\s*(.+?)\s*$/);
          if (newItem) {
            flushCur();
            cur = { name: unquote(newItem[1]), filename: '', runtime: 'python', description: '' };
            continue;
          }
          if (!cur) continue;
          const kv = ln.match(/^\s+(filename|runtime|description):\s*(.+?)\s*$/);
          if (kv) cur[kv[1]] = unquote(kv[2]);
        }
        flushCur();
      }
      try { fs.renameSync(newest.full, folderInfo.folder); }
      catch { _copyDirRecursive(newest.full, folderInfo.folder); fs.rmSync(newest.full, { recursive: true, force: true }); }
      layout = 'folder';
    } else {
      // Flat .md restore: copy single file.
      const content = fs.readFileSync(newest.full, 'utf-8');
      const triggerMatch = content.match(/## Khi nào áp dụng\s*\n([\s\S]+?)(?:\n##|\n*$)/);
      const noiContentMatch = content.match(/## Nội dung\s*\n([\s\S]+?)(?:\n##|\n*$)/);
      const nameMatch = content.match(/^# (.+?)$/m);
      name = nameMatch ? nameMatch[1].trim() : id;
      trigger = triggerMatch ? triggerMatch[1].trim() : '';
      restoredContent = noiContentMatch ? noiContentMatch[1].trim() : '';
      const { target } = safeUserSkillPath(id);
      fs.copyFileSync(newest.full, target);
      try { fs.unlinkSync(newest.full); } catch {}
    }

    const entry = {
      id, name, type: 'custom', appliesTo: [], trigger,
      summary: restoredContent.slice(0, 120),
      enabled: true,
      createdAt: new Date().toISOString(),
      createdVia: 'restore',
      layout,
      scripts,
    };
    registry.skills.push(entry);
    writeRegistry(registry);
    _safeRegenInline();
    _auditSkill('user_skill_restored', { id, name, layout });
    return entry;
  });
}

async function toggleUserSkill(id, enabled) {
  return withSkillLock(async () => {
    const registry = readRegistry();
    const skill = registry.skills.find(s => s.id === id);
    if (!skill) throw new Error(`Skill "${id}" not found.`);
    skill.enabled = !!enabled;
    writeRegistry(registry);
    _safeRegenInline();
    _auditSkill('user_skill_toggled', { id, enabled: !!enabled });
    return skill;
  });
}

function listUserSkills() {
  return readRegistry().skills;
}

function getUserSkillContent(id) {
  const p = resolveUserSkillContentPath(id);
  if (!p) return null;
  try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
}

function checkConflict({ content, appliesTo, trigger }) {
  const registry = readRegistry();
  const activeSkills = registry.skills.filter(s => s.enabled);
  const conflicts = [];
  const newWords = new Set((content + ' ' + trigger).toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const newStandalone = !appliesTo || appliesTo.length === 0;

  for (const skill of activeSkills) {
    const reasons = [];
    const skillStandalone = !skill.appliesTo || skill.appliesTo.length === 0;
    const skillWords = new Set((skill.summary + ' ' + skill.trigger).toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const common = [...newWords].filter(w => skillWords.has(w));

    // Both target specific shipped skills with overlap
    if (!newStandalone && !skillStandalone) {
      const overlap = appliesTo.filter(a => skill.appliesTo.includes(a));
      if (overlap.length > 0 && common.length >= 2) {
        reasons.push(`Same target (${overlap.join(', ')}) with overlapping keywords: ${common.slice(0, 5).join(', ')}`);
      }
    }
    // Both are standalone (apply to everything) — keyword overlap = potential rule conflict
    if (newStandalone && skillStandalone && common.length >= 3) {
      reasons.push(`Both apply to everything with overlapping keywords: ${common.slice(0, 5).join(', ')}`);
    }
    // One standalone, one targeted — standalone catches everything including the target
    if ((newStandalone !== skillStandalone) && common.length >= 3) {
      reasons.push(`Standalone rule may override targeted skill — keywords overlap: ${common.slice(0, 5).join(', ')}`);
    }
    if (trigger && skill.trigger && trigger.toLowerCase() === skill.trigger.toLowerCase()) {
      reasons.push('Identical trigger pattern');
    }
    if (reasons.length > 0) conflicts.push({ skillId: skill.id, skillName: skill.name, reasons });
  }
  return conflicts;
}

function listShippedSkills() {
  const { getWorkspace } = require('./workspace');
  const ws = getWorkspace();
  if (!ws) return [];
  const skillsDir = path.join(ws, 'skills');
  const results = [];
  const categoryMap = {
    operations: 'Vận hành',
    marketing: 'Marketing',
    'image-templates': 'Mẫu hình ảnh',
  };

  function _parseSkillName(filePath, defaultName) {
    let name = defaultName;
    try {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      let inFrontmatter = false;
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        if (t === '---') { inFrontmatter = !inFrontmatter; continue; }
        if (inFrontmatter) {
          if (t.startsWith('name:')) { name = t.slice(5).trim().replace(/^['"]|['"]$/g, '') || name; }
          continue;
        }
        if (t.startsWith('#')) { name = t.replace(/^#+\s*/, '').trim() || name; }
        break;
      }
    } catch {}
    return name;
  }

  function scan(dir, category) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '_archived' || entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        const skillMd = path.join(dir, entry.name, 'SKILL.md');
        if (fs.existsSync(skillMd)) {
          const skillId = (category && category !== 'Ngành' ? path.basename(dir) + '/' : '') + entry.name;
          if (_LEGACY_SHIPPED_SKILL_PATHS.has(skillId)) continue;
          // Anthropic folder skill — treat dir as single skill, do NOT recurse
          const name = _parseSkillName(skillMd, entry.name);
          results.push({
            id: (category && category !== 'Ngành' ? path.basename(dir) + '/' : '') + entry.name,
            name,
            category: category || 'Ngành',
            source: 'shipped',
            layout: 'folder',
          });
          continue;
        }
        // Plain category subdir — recurse
        scan(path.join(dir, entry.name), categoryMap[entry.name] || entry.name);
      } else if (entry.name.endsWith('.md')) {
        const filePath = path.join(dir, entry.name);
        const name = _parseSkillName(filePath, entry.name.replace(/\.md$/, ''));
        results.push({
          id: (category && category !== 'Ngành' ? path.basename(dir) + '/' : '') + entry.name.replace(/\.md$/, ''),
          name,
          category: category || 'Ngành',
          source: 'shipped',
          layout: 'flat',
        });
      }
    }
  }
  scan(skillsDir, '');
  return results;
}

function getShippedSkillContent(relPath) {
  const { getWorkspace } = require('./workspace');
  const ws = getWorkspace();
  if (!ws) return null;
  relPath = _canonicalShippedSkillPath(relPath);
  const skillsDir = path.join(ws, 'skills');
  // Try Anthropic folder layout first: `skills/<relPath>/SKILL.md`
  const folderPath = path.resolve(skillsDir, relPath, 'SKILL.md');
  if (folderPath.startsWith(skillsDir + path.sep) && fs.existsSync(folderPath)) {
    try { return fs.readFileSync(folderPath, 'utf-8'); } catch {}
  }
  // Fall back to flat .md
  const flatPath = path.resolve(skillsDir, relPath + '.md');
  if (!flatPath.startsWith(skillsDir + path.sep)) return null;
  try { return fs.readFileSync(flatPath, 'utf-8'); } catch { return null; }
}

module.exports = {
  createUserSkill, updateUserSkill, deleteUserSkill, toggleUserSkill,
  listUserSkills, getUserSkillContent,
  checkConflict,
  listShippedSkills, getShippedSkillContent,
  slugify, getUserSkillsDir,
  isContentTooLong, SKILL_CONTENT_MAX,
  restoreUserSkill,
  matchActiveSkills, buildSkillInjectionBlock, getSkillContent,
  persistAppliesToMigrationIfNeeded,
  _safeRegenInline,
};
