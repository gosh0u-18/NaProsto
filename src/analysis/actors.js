const { createHash } = require('node:crypto');

function clean(value) {
  return value.normalize('NFC').toLocaleLowerCase('bg').replace(/\s+/gu, ' ').trim();
}
function canonicalRole(role) {
  return clean(role);
}

function containsRole(text, role) {
  if (!role) {
    return false;
  }

  let position = text.indexOf(role);
  while (position !== -1) {
    const before = text.slice(0, position);
    const after = text.slice(position + role.length);
    const startsInsideWord = /[\p{L}\p{N}]$/u.test(before);
    const endsInsideWord = /^[\p{L}\p{N}]/u.test(after);

    if (!startsInsideWord && !endsInsideWord) {
      return true;
    }
    position = text.indexOf(role, position + 1);
  }
  return false;
}

function verifyActor(item, pages) {
  if (!item.actor) {
    return { actorVerificationStatus: 'unknown' };
  }
  const page = pages.find((page) => page.pageNumber === item.pageNumber);
  const evidence = item.actor.sourceQuote;
  const role = canonicalRole(item.actor.role);
  const hasSource = page && item.sourceQuote.trim() && page.text.includes(item.sourceQuote) &&
    evidence.trim() && item.sourceQuote.includes(evidence);
  const hasRole = containsRole(clean(evidence), role);
  return { actorVerificationStatus: hasSource && hasRole ? 'verified' : 'unverified' };
}

function collectRoles(items) {
  const groups = new Map();
  for (const item of items) {
    if (item.verificationStatus !== 'verified' || item.actorVerificationStatus !== 'verified' || !item.actor) {
      continue;
    }
    const canonical = canonicalRole(item.actor.role);
    if (!groups.has(canonical)) groups.set(canonical, {
      id: `role-${createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`,
      label: canonical.charAt(0).toLocaleUpperCase('bg') + canonical.slice(1), findingIds: [],
    });
    groups.get(canonical).findingIds.push(item.id);
  }
  return [...groups.values()];
}

module.exports = { verifyActor, collectRoles, canonicalRole };
