// Validates swarm protocol payloads against the JSON Schemas in this folder.
// Errors name the offending field (JSON pointer) so API callers can fix input.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ajv = new Ajv({ allErrors: true });
const compiled = new Map();
let schemasLoaded = false;

function schemaName(file) {
  return path.relative(HERE, file).split(path.sep).join('/').replace(/\.schema\.json$/, '');
}

function schemaFiles(dir = HERE) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'test') return schemaFiles(file);
    return entry.isFile() && entry.name.endsWith('.schema.json') ? [file] : [];
  });
}

function loadSchemas() {
  if (schemasLoaded) return;
  for (const file of schemaFiles()) {
    const schema = JSON.parse(readFileSync(file, 'utf8'));
    ajv.addSchema(schema, schema.$id || schemaName(file));
  }
  schemasLoaded = true;
}

/** Schema names: 'task', 'epic', 'api/<call>.request', 'events/event'. */
function getValidator(name) {
  loadSchemas();
  if (!compiled.has(name)) {
    const validator = ajv.getSchema(name);
    if (!validator) throw new Error(`unknown protocol schema: ${name}`);
    compiled.set(name, validator);
  }
  return compiled.get(name);
}

function describe(err) {
  const field = err.instancePath || '/';
  const extra = err.params?.additionalProperty ? ` '${err.params.additionalProperty}'` : '';
  return `${field} ${err.message}${extra}`;
}

export function validate(name, data) {
  const check = getValidator(name);
  if (check(data)) return { ok: true, errors: [] };
  return { ok: false, errors: check.errors.map(describe) };
}

/** Validates the body of GET /snapshot. */
export function validateSnapshotResponse(data) {
  return validate('api/snapshot.response', data);
}

export function assertValid(name, data) {
  const { ok, errors } = validate(name, data);
  if (!ok) throw new Error(`invalid ${name}: ${errors.join('; ')}`);
}
