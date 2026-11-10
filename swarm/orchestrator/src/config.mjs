// Loads and cross-checks departments.yaml and policy.yaml. Any problem throws
// one error that names the file and every offending item, so start-up stops
// before the orchestrator takes any work.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { validate } from '../../protocol/validate.mjs';
import { overlaps, splitGlob } from '../../shared/globs.mjs';
import { allChannels, isValidChannelName, deptChannel } from './events.mjs';

function fail(source, problems) {
  throw new Error(`${source}:\n  - ${problems.join('\n  - ')}`);
}

export function parseDepartments(doc, source = 'departments') {
  const check = validate('departments', doc);
  if (!check.ok) fail(source, check.errors);
  const problems = [];
  const entries = Object.entries(doc.departments);
  for (const glob of doc.contracts) {
    try { splitGlob(glob); } catch (err) { problems.push(`contracts: ${err.message}`); }
  }
  for (const [id, dept] of entries) {
    if (dept.standby !== null && dept.standby === dept.host) {
      problems.push(`${id}: standby and host are the same (${dept.host})`);
    }
    for (const glob of dept.paths) {
      try { splitGlob(glob); } catch (err) { problems.push(`${id}: ${err.message}`); }
    }
  }
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const [idA, a] = entries[i];
      const [idB, b] = entries[j];
      for (const ga of a.paths) {
        for (const gb of b.paths) {
          let hit = false;
          try { hit = overlaps(ga, gb); } catch { hit = false; }
          if (hit) problems.push(`paths overlap: ${idA} "${ga}" vs ${idB} "${gb}"`);
        }
      }
    }
  }
  for (const id of Object.keys(doc.departments)) {
    if (!isValidChannelName(deptChannel(id))) problems.push(`${id}: channel dept-${id} is not a valid bus name (64 characters at most)`);
  }
  if (!allChannels(Object.keys(doc.departments)).every(isValidChannelName)) problems.push('a swarm channel name is not valid for the bus');
  if (problems.length) fail(source, problems);
  return doc;
}

export function parsePolicy(doc, source = 'policy') {
  const check = validate('policy', doc);
  if (!check.ok) fail(source, check.errors);
  doc.models.antigravity ??= [];
  const all = new Set([...doc.models.claude, ...doc.models.codex, ...doc.models.gemini, ...doc.models.antigravity]);
  const problems = [];
  for (const role of ['default', 'large']) {
    if (!all.has(doc.reviewModel[role])) problems.push(`reviewModel.${role} ${doc.reviewModel[role]} is not on the model allow-list`);
  }
  for (const agent of ['claude', 'codex', 'gemini', 'antigravity']) {
    if (new Set(doc.models[agent]).size !== doc.models[agent].length) problems.push(`models.${agent} has duplicates`);
  }
  if (problems.length) fail(source, problems);
  return doc;
}

/** Department agents must have models on the allow-list. */
export function checkDepartmentModels(departments, policy, source = 'departments') {
  const problems = [];
  for (const [id, dept] of Object.entries(departments.departments)) {
    if (policy.models[dept.agent].length === 0) {
      problems.push(`${id}: agent ${dept.agent} has no models on the allow-list in policy.yaml`);
    }
  }
  if (problems.length) fail(source, problems);
}

/** Department facts for the snapshot (protocol api/snapshot.response): one entry per department, as loaded. */
export function departmentInfoOf(departments) {
  return Object.entries(departments.departments).map(([id, dept]) => ({
    id,
    agent: dept.agent,
    paths: [...dept.paths],
    concurrency: dept.concurrency,
    maxSubagents: dept.maxSubagents,
    host: dept.host ?? null,
  }));
}

export function loadDepartments(file) {
  return parseDepartments(parse(readFileSync(file, 'utf8')), file);
}

export function loadPolicy(file) {
  return parsePolicy(parse(readFileSync(file, 'utf8')), file);
}

/** Validates a model id for an agent kind against the policy allow-list. */
export function validateModel(policy, agent, modelId) {
  if (typeof modelId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(modelId)) {
    throw new Error(`model id is not a plain string: ${JSON.stringify(modelId)}`);
  }
  if (!policy.models[agent]?.includes(modelId)) {
    throw new Error(`model ${modelId} is not on the ${agent} allow-list`);
  }
  return modelId;
}
