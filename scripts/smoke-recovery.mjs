import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const live = process.argv.includes('--live');
const output = path.join(root, 'artifacts', 'recovery-' + Date.now());
const data = path.join(output, 'user-data');
fs.mkdirSync(data, { recursive: true });
const probe = net.createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const env = { ...process.env, AUTOMATA_USER_DATA: data };
delete env.ELECTRON_RUN_AS_NODE;
delete env.AUTOMATA_SMOKE;
const child = spawn(path.join(root, 'dist/Automata-Windows/Automata.exe'), [...live ? [] : ['--demo'], '--port', '0', '--remote-debugging-port=' + port], { env, windowsHide: true, stdio: 'ignore' });
child.on('error', error => console.error(error.message));
let browser, page;
const deadline = Date.now() + 40000;
while (Date.now() < deadline) {
  try {
    const boot = fs.existsSync(path.join(data, 'boot.log')) ? fs.readFileSync(path.join(data, 'boot.log'), 'utf8') : '';
    if (!boot.includes('interface loaded')) { await new Promise(r => setTimeout(r, 300)); continue; }
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 3000 });
    page = browser.contexts()[0].pages().find(p => p.url().startsWith('automata://app/'));
    if (!page) throw new Error('The app window has not loaded.');
    await page.waitForFunction(isLive => isLive ? document.querySelector('#accountsDialog')?.open : document.querySelector('#projectName')?.textContent === 'Hola, Automata', live, { timeout: 5000 });
    break;
  } catch { await browser?.close().catch(() => {}); browser = null; await new Promise(r => setTimeout(r, 300)); }
}
if (!page || !browser) throw new Error('Native startup did not recover. Read ' + path.join(data, 'boot.log'));
try {
  const info = await page.evaluate(async () => {
    const c = await window.automata.connection();
    return { node: typeof window.require, compatibilityMode: c.compatibilityMode, title: document.title, version: (await window.automata.request('capabilities')).version };
  });
  if (info.node !== 'undefined') throw new Error('Node is exposed to the renderer.');
  const security = await page.evaluate(async () => {
    const escapedAsset = await fetch('automata://app/%2e%2e%5cdesktop/main.cjs');
    let invalidIpcRejected = false;
    try { await window.automata.request('invalid-route'); } catch { invalidIpcRejected = true; }
    return { escapedAssetStatus: escapedAsset.status, invalidIpcRejected };
  });
  if (security.escapedAssetStatus !== 404 || !security.invalidIpcRejected) throw new Error('Local UI boundary check failed.');
  let accounts;
  if (live) {
    await page.waitForFunction(() => !['coder', 'auditor'].some(role => document.querySelector('#' + role + 'AccountState').textContent === 'Comprobando'), null, { timeout: 30000 });
    accounts = await page.evaluate(() => Object.fromEntries(['coder', 'auditor'].map(role => [role, document.querySelector('#' + role + 'AccountState').textContent])));
    await page.screenshot({ path: path.join(output, 'windows-login.png'), timeout: 10000 });
    await page.click('#accountsDialog [data-close]');
  } else {
    await page.click('#accountsButton');
    await page.waitForFunction(() => document.querySelector('#coderAccountState').textContent === 'Demostración');
    await page.click('#accountsDialog [data-close]');
  }
  await page.screenshot({ path: path.join(output, 'windows.png'), timeout: 10000 });
  let nativeChat;
  if (!live) {
    await page.click('#startButton');
    await page.waitForFunction(() => document.querySelector('#runState').textContent === 'Completado', null, { timeout: 25000 });
    await page.fill('#chatText', 'Consulta de prueba del estado de respuesta.');
    await page.click('#chatForm button[type=submit]');
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('está respondiendo'));
    const notice = await page.locator('#toast').textContent();
    await page.waitForFunction(() => document.querySelector('.chat-answer')?.textContent.includes('demostración'));
    nativeChat = { notice, answered: true, demo: true };
  }
  const result = { ok: true, automaticRecovery: info.compatibilityMode, info, security, live, accounts, nativeChat, output };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  const session = await browser.newBrowserCDPSession();
  await Promise.race([session.send('Browser.close').catch(() => {}), new Promise(resolve => setTimeout(resolve, 1500))]);
}
