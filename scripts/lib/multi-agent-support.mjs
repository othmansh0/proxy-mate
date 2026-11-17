import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { listen, closeServer, request, stopChild, summarize } from './load-support.mjs';
const root = path.resolve(import.meta.dirname, '../..');

export async function runMultiAgent(config) {
  const start = Date.now(), home = await mkdtemp(path.join(os.tmpdir(), 'proxy-multi-'));
  const env = { ...process.env, PROXY_MATE_HOME: home, PROXY_MATE_ALLOW_FAKE_NETWORKSETUP: '1',
    PROXY_MATE_FAKE_NETWORKSETUP: path.join(root, 'test/fixtures/fake-networksetup.mjs'),
    PROXY_MATE_FAKE_NETWORK_STATE: path.join(home, 'fake-network.json'), PROXY_MATE_FAKE_HOST_TRUST: 'trusted',
    PROXY_MATE_TEST_HEARTBEAT_MS: '1000', PROXY_MATE_TEST_MISSED_BEATS: '5', PROXY_MATE_TEST_STARTUP_GRACE_MS: '6000', PROXY_MATE_PAC_HOST: 'in-process' };
  Object.assign(process.env, env); // Isolated process, before dynamic src imports.
  const report = { passed: false, phases: [], guardian: [], policy_decisions: [], requests: [], restart_errors: [] };
  const children = [], clients = [], cpu = [];
  let cancelled = false;
  const interrupt = () => { cancelled = true; for (const p of children) if (p.exitCode === null && p.signalCode === null) p.kill('SIGTERM'); };
  process.on('SIGTERM', interrupt); process.on('SIGINT', interrupt);
  let daemon, guardianTimer, guardianTask = Promise.resolve(), upstream, log = '', stopping = false, monitoring = false;
  const spawnOwned = (args, options = {}) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'], ...options });
    children.push(child); child.stderr?.on('data', b => { log = (log + b).slice(-20000); }); return child;
  };
  const until = async (fn, ms = 15000) => {
    const end = Date.now() + ms; let last;
    do { if (cancelled) throw new Error('Qualification interrupted'); try { const value = await fn(); if (value) return value; } catch (e) { last = e; } await delay(100); } while (Date.now() < end);
    throw new Error('Condition deadline exceeded: ' + (last?.message ?? '') + '\n' + log);
  };
  const callRaw = (i, name, args = {}) => clients[i].client.callTool({ name, arguments: args });
  const call = async (i, name, args = {}) => {
    const result = await callRaw(i, name, args);
    assert.ok(!result.isError, JSON.stringify({ name, result })); return result.structuredContent?.data;
  };
  const network = async () => JSON.parse(await readFile(env.PROXY_MATE_FAKE_NETWORK_STATE, 'utf8'));
  const phase = name => { report.phases.push({ name, elapsed_ms: Date.now() - start }); };
  try {
    await writeFile(env.PROXY_MATE_FAKE_NETWORK_STATE, JSON.stringify({ service: 'Fake Primary', services: ['Fake Primary'], url: '', enabled: false, web_proxy: { enabled: false }, secure_web_proxy: { enabled: false } }));
    const reservations = Array.from({ length: 3 }, () => http.createServer());
    let ports;
    try { ports = await Promise.all(reservations.map(listen)); } finally { await Promise.all(reservations.map(closeServer)); }
    assert.ok(ports.every(p => ![8080, 8081, 8082].includes(p)));
    report.ports = ports;
    const daemonArgs = ['src/server.mjs', '--daemon', '--no-routing', '--no-trust-ca', '--no-host-trust', '--proxy-port', '' + ports[0], '--pac-port', '' + ports[1], '--control-port', '' + ports[2], '--network-service', 'Fake Primary'];
    const boot = async () => {
      daemon = spawnOwned(daemonArgs);
      await until(async () => {
        if (daemon.exitCode !== null || daemon.signalCode !== null) throw new Error('daemon exited');
        const hs = JSON.parse(await readFile(path.join(home, 'handshake.json'), 'utf8'));
        return (await request({ host: '127.0.0.1', port: ports[2], path: '/health', headers: { authorization: `Bearer ${hs.token}` } })).status === 200;
      }, 20000);
    };
    await boot();
    monitoring = true;
    const { createGuardian, healthTimeoutPolicy } = await import('../../src/lib/guardian.mjs');
    const tick = createGuardian({ directory: home, shouldTerminate: details => {
      const decision = healthTimeoutPolicy(details); if (decision) report.policy_decisions.push(details.decision); return decision;
    }, signal: (pid, sig) => { assert.equal(pid, daemon.pid); report.policy_decisions.push(sig); }, log: () => {} });
    guardianTimer = setInterval(() => {
      guardianTask = guardianTask.then(async () => { if (!stopping && monitoring && daemon.exitCode === null && daemon.signalCode === null) report.guardian.push(await tick()); });
    }, 500);
    for (let i = 0; i < 3; i++) {
      const client = new Client({ name: `multi-${i}`, version: '1' });
      const transport = new StdioClientTransport({ command: process.execPath, args: ['src/client.mjs'], cwd: root, env, stderr: 'pipe' });
      clients.push({ client, transport }); await client.connect(transport);
      clients.at(-1).pid = transport.pid;
      transport.stderr?.on('data', () => {});
      await call(i, 'get_started', { task_id: `task-${i}` });
    }
    const owners = [];
    const claimIds = [];
    for (const [i, domains] of [[0, ['a.test', 'shared.test']], [1, ['b.test']], [2, ['shared.test']]]) {
      const status = await call(i, 'get_proxy_status');
      assert.equal(status.fake_host_trust, true);
      owners.push(status.clients.me.client_id);
      const result = await call(i, 'set_proxy_routing', { domains, network_service: 'Fake Primary',
        duration_seconds: 3600, device_udid: i === 1 ? '22222222-2222-2222-2222-222222222222' : '11111111-1111-1111-1111-111111111111' });
      claimIds.push(result.claim.claim_id);
    }
    const assertPac = async domains => {
      const state = await network();
      assert.equal(state.enabled, true);
      const url = new URL(state.url);
      assert.equal(url.hostname, '127.0.0.1');
      assert.equal(Number(url.port), ports[1]);
      assert.notEqual(Number(url.port), 8081);
      const pac = await request({ host: url.hostname, port: url.port, path: url.pathname });
      assert.equal(pac.status, 200);
      assert.match(pac.body, new RegExp(`PROXY 127\\.0\\.0\\.1:${ports[0]}; DIRECT`));
      assert.deepEqual([...pac.body.matchAll(/shExpMatch\(host, "([^"]+)"\)/g)].map(m => m[1]).sort(), [...domains].sort());
      report.pac_url = state.url;
    };
    await assertPac(['a.test', 'b.test', 'shared.test']);
    for (let i = 0; i < 3; i++) {
      const status = await call(i, 'get_proxy_status');
      assert.equal(status.routing_claims.length, 3);
      for (const claim of status.routing_claims) assert.equal(claim.mine, claim.client_id === owners[i]);
      assert.equal(status.routing_claims.filter(c => c.mine).length, 1);
    }
    assert.match(log, /test-only fake host trust status active/);
    phase('union PAC and ownership');
    for (const [i, host] of [[0, 'a.test'], [1, 'b.test'], [2, 'shared.test']]) await call(i, 'mock_json_response', { url: `http://${host}/hit`, json: { host } });
    const traffic = async host => {
      const before = performance.now();
      const response = await request({ host: '127.0.0.1', port: ports[0], path: `http://${host}/hit` }, { timeoutMs: 15000 });
      assert.equal(response.status, 200); assert.equal(JSON.parse(response.body).host, host);
      report.requests.push({ outcome: 'ok', latency_ms: performance.now() - before }); return response;
    };
    const workers = Math.round(config.cpuFactor * os.cpus().length);
    for (let i = 0; i < workers; i++) cpu.push(spawnOwned(['-e', 'for (;;) Math.sqrt(Math.random())']));
    report.cpu_children = workers;
    const end = Date.now() + config.seconds * 1000;
    do { await Promise.all(['a.test', 'b.test', 'shared.test'].map(traffic)); await delay(50); } while (Date.now() < end);
    await Promise.all(cpu.map(p => stopChild(p, 1000)));
    // The live ring is bounded; qualification may capture more than 500 flows.
    await until(async () => {
      const listing = await call(0, 'list_capture_sessions');
      return listing.sessions.find(s => s.id === listing.active_session_id)?.flow_count === report.requests.length;
    });
    const all = await call(0, 'get_flows', { scope: 'all', limit: 200 });
    for (const [i, hosts] of [[0, ['a.test', 'shared.test']], [1, ['b.test']], [2, ['shared.test']]]) {
      const mine = await call(i, 'get_flows', { limit: 200 });
      assert.ok(mine.flows.length > 0);
      assert.ok(mine.flows.every(f => hosts.includes(new URL(f.url).hostname)));
      assert.equal(mine.hidden_count, all.total - mine.total);
      (report.scoped_counts ??= []).push({ client: i, visible: mine.total, hidden: mine.hidden_count });
      if (i !== 1) assert.ok(mine.flows.some(f => new URL(f.url).hostname === 'shared.test'));
    }
    assert.ok(all.flows.some(f => new URL(f.url).hostname === 'shared.test' && f.attribution === 'ambiguous'));
    assert.equal((await call(1, 'wait_for_flow', { host_equals: 'a.test', include_existing: true, timeout_ms: 300 })).matched, false);
    await call(0, 'clear_session');
    assert.ok((await call(1, 'get_flows')).flows.length > 0); phase('scoped traffic');
    let arrived;
    upstream = http.createServer((req, res) => { if (req.url === '/prime') return res.end('prime-ok'); arrived?.(); setTimeout(() => res.end('slow-ok'), 2000).unref(); });
    const upstreamPort = await listen(upstream);
    const primeUrl = `http://127.0.0.1:${upstreamPort}/prime`;
    // A deliberately out-of-scope local request warms the async claims snapshot.
    await call(0, 'create_breakpoint', { rule_id: 'prime-scope', url: primeUrl, scope: 'mine' });
    assert.equal((await request({ host: '127.0.0.1', port: ports[0], path: primeUrl })).body, 'prime-ok');
    await call(0, 'remove_rule', { rule_id: 'prime-scope' });
    await call(0, 'create_breakpoint', { url: 'http://a.test/paused', scope: 'mine', direction: 'request' });
    const paused = request({ host: '127.0.0.1', port: ports[0], path: 'http://a.test/paused' }, { timeoutMs: 15000 });
    paused.catch(() => {});
    const pending = await until(async () => (await call(1, 'list_pending_breakpoints')).breakpoints[0]);
    await traffic('b.test');
    await call(1, 'resolve_breakpoint', { breakpoint_id: pending.id ?? pending.breakpoint_id, action: 'respond', response: { statusCode: 200, body: 'resolved' } });
    assert.equal((await paused).status, 200);
    const blocked = await callRaw(1, 'stop_proxy');
    assert.equal(blocked.structuredContent.error.code, 'OTHER_CLIENTS_ACTIVE'); phase('breakpoints and global guard');
    const cleared = await call(0, 'clear_proxy_routing');
    assert.deepEqual(cleared.removed_claims.map(c => c.claim_id), [claimIds[0]]);
    await assertPac(['b.test', 'shared.test']);
    for (const i of [1, 2]) assert.equal((await call(i, 'get_proxy_status')).routing_claims.find(c => c.mine).state, 'active');
    phase('per-client routing clear');
    // Guarantee traffic is in flight before the hard kill using a local delayed upstream.
    await call(1, 'create_map_remote', { from_url: 'http://b.test/slow', to_url: `http://127.0.0.1:${upstreamPort}/slow` });
    const slow = () => request({ host: '127.0.0.1', port: ports[0], path: 'http://b.test/slow' }, { timeoutMs: 15000 });
    const entered = new Promise(resolve => { arrived = resolve; });
    const killedRequest = slow().then(r => ({ status: r.status }), e => ({ error: e.code }));
    await entered;
    monitoring = false; await guardianTask;
    const exited = once(daemon, 'close'); daemon.kill('SIGKILL'); await exited;
    report.hard_kill_request = await killedRequest;
    assert.ok(report.hard_kill_request.error || report.hard_kill_request.status >= 500);
    await Promise.all([0, 1, 2].map(async i => {
      const unavailable = await callRaw(i, 'get_proxy_status');
      assert.ok(['DAEMON_UNAVAILABLE', 'DAEMON_DISCONNECTED'].includes(unavailable.structuredContent.error.code));
      assert.equal(unavailable.structuredContent.error.retryable, true);
      report.restart_errors.push(unavailable.structuredContent.error.code);
    }));
    await boot();
    for (let i = 0; i < 3; i++) assert.equal((await call(i, 'get_proxy_status')).running, true);
    await until(async () => (await call(1, 'get_proxy_status')).routing_claims.find(c => c.mine)?.state === 'active');
    await assertPac(['b.test', 'shared.test']);
    assert.deepEqual((await call(1, 'get_proxy_status')).routing_claims.map(c => c.claim_id).sort(), claimIds.slice(1).sort());
    monitoring = true;
    phase('hard restart and routing re-arm');
    const draining = new Promise(resolve => { arrived = resolve; });
    const gracefulRequest = slow(); gracefulRequest.catch(() => {}); await draining;
    monitoring = false; await guardianTask;
    const gracefulExit = once(daemon, 'close'), drainStarted = performance.now(); daemon.kill('SIGTERM');
    const drained = await gracefulRequest;
    report.graceful_request = { status: drained.status, body: drained.body, drain_ms: performance.now() - drainStarted };
    assert.equal(drained.body, 'slow-ok'); await gracefulExit;
    assert.equal((await network()).enabled, false);
    await boot();
    await until(async () => (await call(1, 'get_proxy_status')).routing_claims.find(c => c.mine)?.state === 'active');
    await assertPac(['b.test', 'shared.test']);
    monitoring = true;
    phase('graceful drain');
    // A VPN takes ownership while the daemon is down. Startup must preserve it.
    monitoring = false; await guardianTask;
    const vpnExit = once(daemon, 'close'); daemon.kill('SIGKILL'); await vpnExit;
    const vpn = { ...await network(), enabled: true, url: 'https://vpn.example.test/proxy.pac' };
    await writeFile(env.PROXY_MATE_FAKE_NETWORK_STATE, JSON.stringify(vpn));
    await boot();
    const { readRuntimeEvents } = await import('../../src/lib/runtime-identity.mjs');
    await until(async () => (await readRuntimeEvents()).some(e => e.pid === daemon.pid && e.event === 'routing_not_rearmed' && e.reason === 'external_change'));
    assert.ok(!(await readRuntimeEvents()).some(e => e.pid === daemon.pid && e.event === 'routing_rearmed'));
    assert.deepEqual(await network(), vpn);
    for (const i of [1, 2]) {
      const status = await call(i, 'get_proxy_status');
      assert.equal(status.routing_active, false);
      assert.equal(status.routing_warning.state, 'suspended');
      assert.equal(status.routing_warning.reason, 'external_change');
    }
    monitoring = true;
    phase('external PAC preserved and routing warning');
    // Explicit owner consent restores routing for the presence-cleanup check.
    await call(1, 'set_proxy_routing', { domains: ['b.test'], network_service: 'Fake Primary', replace_existing_proxy: true });
    await assertPac(['b.test', 'shared.test']);
    for (let i = 0; i < 3; i++) await call(i, 'get_proxy_status');
    // Close exactly stdin: do not stop the daemon or alter another bridge.
    clients[2].transport._process.stdin.end();
    await until(async () => (await call(0, 'get_proxy_status')).clients.alive === 2, 22000);
    await until(async () => (await call(0, 'get_proxy_status')).recent_runtime_events.some(e => e.event === 'client_presence_lost'), 22000);
    await until(async () => !(await call(1, 'get_proxy_status')).routing_claims.some(c => c.client_id === owners[2]), 22000);
    await assertPac(['b.test']);
    const remaining = (await call(1, 'get_proxy_status')).routing_claims;
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].mine, true);
    assert.equal(remaining[0].state, 'active');
    report.routing = { claims_survived_restart: 2, vpn_preserved: true, presence_remaining: 1 };
    assert.equal((await call(0, 'get_proxy_status')).clients.me.task_id, 'task-0');
    assert.equal((await call(1, 'get_proxy_status')).clients.me.task_id, 'task-1');
    await guardianTask;
    assert.ok(report.guardian.length > 0);
    assert.deepEqual(report.policy_decisions, []); phase('presence and guardian');
    report.passed = true;
  } catch (error) { report.error = { message: error.message, stack: error.stack, log }; }
  finally {
    stopping = true; clearInterval(guardianTimer); await guardianTask;
    await Promise.all(cpu.map(p => stopChild(p, 1000)));
    await Promise.allSettled(clients.map(c => c.client.close()));
    await stopChild(daemon);
    await closeServer(upstream);
    report.cleanup = { children_stopped: children.every(p => p.exitCode !== null || p.signalCode !== null),
      bridge_pids: clients.map(c => c.pid), bridges_stopped: clients.every(c => { try { process.kill(c.pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } }) };
    if (!report.cleanup.children_stopped || !report.cleanup.bridges_stopped) { report.passed = false; report.error ??= { message: 'Owned process cleanup failed' }; }
    process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
    await rm(home, { recursive: true, force: true });
  }
  report.elapsed_ms = Date.now() - start;
  report.traffic = summarize(report.requests); delete report.requests;
  return report;
}
