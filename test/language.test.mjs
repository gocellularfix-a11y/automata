import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSettings } from '../server/config.mjs';
import { directorPrompt, coderPrompt, chatPrompt } from '../server/prompts.mjs';
import { DemoAgents } from '../server/agents.mjs';
test('language is persisted as an explicit supported setting and prompts retain original criteria', async () => {
  assert.equal(validateSettings().language, 'es');
  assert.equal(validateSettings({ language: 'en' }).language, 'en');
  assert.throws(() => validateSettings({ language: 'fr' }), /English/);
  const project = { name: 'Proyecto', directory: 'C:/example', objective: 'Un reloj', criteria: ['Funciona en español.'], checks: [] };
  const settings = validateSettings({ language: 'en' });
  assert.match(directorPrompt(project, settings, { phase: 'plan' }), /IDIOMA DE RESPUESTA: English/);
  assert.match(directorPrompt(project, settings, { phase: 'plan' }), /Funciona en español\./);
  assert.match(coderPrompt(project, settings, 'Build', ''), /reporte en English/);
  assert.match(chatPrompt(project, 'auditor', 'Build', '', settings), /Responde en English/);
  assert.match((await new DemoAgents().run({ phase: 'task', settings })).text, /local demo/);
});
