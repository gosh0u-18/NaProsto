const { parseCandidateAnalysis, getValidationDiagnostics } = require('./schema');

function filterCandidate(candidate) {
  try {
    return { candidate: parseCandidateAnalysis(candidate), rejectedIndices: [], validationDiagnostics: null };
  } catch (error) {
    const diagnostics = getValidationDiagnostics(error);
    if (!diagnostics || !error.issues.length) throw error;

    const rejected = new Set();
    for (const issue of error.issues) {
      const match = /^\/items\/(\d+)\/deadline$/.exec(issue.path);
      if (!match) throw error;
      rejected.add(Number(match[1]));
    }
    const items = candidate.items.filter((item, index) => !rejected.has(index));
    if (!items.length && !candidate.documentContext.length) throw error;

    const checked = parseCandidateAnalysis({ ...candidate, items });
    return { candidate: checked, rejectedIndices: [...rejected], validationDiagnostics: diagnostics };
  }
}

module.exports = { filterCandidate };
