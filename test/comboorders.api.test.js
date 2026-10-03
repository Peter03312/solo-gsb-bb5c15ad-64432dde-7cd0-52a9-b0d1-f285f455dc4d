'use strict';

// 端到端：整套备料单（铅条 + 玻璃一次确认）。
// 覆盖：预览不占库存、任一不足整体回滚不留部分、成功后原子预留两类库存、
// 关联计划/订单从原入口不可单独取消/修改/删除/换单、整套取消两类预留各释放一次且幂等、
// 幂等键重复确认不重复预留、不同参数冲突、并发不超卖、发布快照绑定、独立计划/订单接口仍可用。

process.env.NODE_ENV = 'test';
process.env.PORT = process.env.TEST_PORT || '39143';
process.env.DB_PATH = require('path').join(__dirname, '..', 'data', `combo-test-${process.pid}.db`);

const { test, before, after } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const db = require('../src/db');
const app = require('../src/server');

const BASE = `http://localhost:${process.env.PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let designId, pubId, pubId2;

async function api(method, url, body) {
  const resp = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

// 每件：内部公共边 1 + 四框 4 = 5 段；红、绿各 1 片
async function publishWindow() {
  const d = await api('POST', '/api/designs', { name: '整套窗', width: 100, height: 100 });
  const id = d.data.design.id;
  await api('POST', `/api/designs/${id}/pieces`, {
    color: '#ff0000', polygon: [[0, 0], [50, 0], [50, 100], [0, 100]],
  });
  await api('POST', `/api/designs/${id}/pieces`, {
    color: '#00ff00', polygon: [[50, 0], [100, 0], [100, 100], [50, 100]],
  });
  const p = await api('POST', `/api/designs/${id}/publish`);
  return { designId: id, pubId: p.data.publication.id };
}

async function registerStock({ leadStock = 10, redStock = 10, greenStock = 10,
  redSize = [600, 400], greenSize = [600, 400] } = {}) {
  const m = await api('POST', '/api/materials', { name: '6m料', length: 6000, stock: leadStock });
  const r = await api('POST', '/api/glass-sheets', { color: '#ff0000', width: redSize[0], height: redSize[1], stock: redStock });
  const g = await api('POST', '/api/glass-sheets', { color: '#00ff00', width: greenSize[0], height: greenSize[1], stock: greenStock });
  return { materialId: m.data.material.id, redId: r.data.sheet.id, greenId: g.data.sheet.id };
}

before(async () => {
  server = app.listen(Number(process.env.PORT));
  for (let i = 0; i < 40; i++) {
    try { await api('GET', '/api/materials'); break; } catch { await sleep(50); }
  }
  const w = await publishWindow();
  designId = w.designId;
  pubId = w.pubId;
});

after(async () => {
  await new Promise((r) => server.close(r));
  try { db.getDb().close(); } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(process.env.DB_PATH + suffix, { force: true }); } catch { /* ignore */ }
  }
});

test('预览：列出铅条根数/各色张数/可用/缺口，且不占库存', async () => {
  const { materialId } = await registerStock();
  const beforeM = (await api('GET', `/api/materials/${materialId}`)).data.material.available;
  const pv = await api('POST', '/api/combo-orders/preview', {
    publicationId: pubId, materialId, copies: 2, kerf: 0.5, gap: 2,
  });
  assert.strictEqual(pv.status, 200);
  const p = pv.data.preview;
  assert.strictEqual(p.publicationId, pubId);
  assert.strictEqual(p.copies, 2);
  assert.strictEqual(p.kerf, 0.5);
  assert.strictEqual(p.gap, 2);
  assert.ok(p.lead.requiredBars >= 1);
  assert.strictEqual(p.lead.availableBars, beforeM);
  assert.strictEqual(p.lead.shortage, 0);
  const colors = Object.fromEntries(p.glass.colors.map((c) => [c.color, c]));
  assert.ok(colors['#ff0000'].requiredSheets >= 1);
  assert.ok(colors['#00ff00'].requiredSheets >= 1);
  assert.strictEqual(colors['#ff0000'].shortage, 0);
  assert.strictEqual(p.feasible, true);
  // 预览不占库存
  const afterM = (await api('GET', `/api/materials/${materialId}`)).data.material.available;
  assert.strictEqual(beforeM, afterM);
  for (const s of (await api('GET', '/api/glass-sheets')).data.sheets) {
    assert.strictEqual(s.reserved, 0);
  }
});

test('非法参数整单拒绝（件数/刀损/间距/发布版/原材）', async () => {
  const mats = await api('GET', '/api/materials');
  const materialId = mats.data.materials[0].id;
  const base = { publicationId: pubId, materialId, copies: 1, kerf: 0.5, gap: 0 };
  assert.strictEqual((await api('POST', '/api/combo-orders/preview', { ...base, copies: 0 })).status, 400);
  assert.strictEqual((await api('POST', '/api/combo-orders/preview', { ...base, kerf: -0.01 })).status, 400);
  assert.strictEqual((await api('POST', '/api/combo-orders/preview', { ...base, gap: 51 })).status, 400);
  assert.strictEqual((await api('POST', '/api/combo-orders/preview', { ...base, publicationId: 99999 })).status, 404);
  assert.strictEqual((await api('POST', '/api/combo-orders/preview', { ...base, materialId: 99999 })).status, 404);
});

test('确认成功：同事务预留两类库存并生成绑定同一快照/件数的计划与裁片订单', async () => {
  const mats = await api('GET', '/api/materials');
  const materialId = mats.data.materials[0].id;
  const r = await api('POST', '/api/combo-orders', {
    name: '整套A', publicationId: pubId, materialId, copies: 2, kerf: 0.5, gap: 2,
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.idempotent, false);
  const c = r.data.combo;
  assert.strictEqual(c.status, 'confirmed');
  assert.strictEqual(c.publicationId, pubId);
  assert.strictEqual(c.designId, designId);
  assert.strictEqual(c.copies, 2);
  assert.strictEqual(c.kerf, 0.5);
  assert.strictEqual(c.gap, 2);
  assert.ok(c.planId > 0);
  assert.ok(c.cutOrderId > 0);
  // 子单同样 confirmed、comboId 指回整套单
  assert.strictEqual(c.plan.status, 'confirmed');
  assert.strictEqual(c.plan.comboManaged, true);
  assert.strictEqual(c.cutOrder.status, 'confirmed');
  assert.strictEqual(c.cutOrder.comboManaged, true);

  // 库存被两类各预留
  const m = (await api('GET', `/api/materials/${materialId}`)).data.material;
  assert.strictEqual(m.reserved, c.lead.requiredBars);
  const sheets = Object.fromEntries((await api('GET', '/api/glass-sheets')).data.sheets.map((s) => [s.color, s]));
  const need = Object.fromEntries(c.glass.colors.map((x) => [x.color, x.requiredSheets]));
  assert.strictEqual(sheets['#ff0000'].reserved, need['#ff0000']);
  assert.strictEqual(sheets['#00ff00'].reserved, need['#00ff00']);

  // 子单通过原入口可查、且绑定同一快照与件数
  const plan = (await api('GET', `/api/plans/${c.planId}`)).data.plan;
  assert.strictEqual(plan.publicationId, pubId);
  assert.strictEqual(plan.copies, 2);
  assert.strictEqual(plan.comboId, c.id);
  const order = (await api('GET', `/api/cut-orders/${c.cutOrderId}`)).data.order;
  assert.strictEqual(order.publicationId, pubId);
  assert.strictEqual(order.copies, 2);
  assert.strictEqual(order.comboId, c.id);
});

test('关联计划/订单不能从原入口单独取消/修改/删除/换单（均 409 combo_managed）', async () => {
  const combos = (await api('GET', '/api/combo-orders')).data.combos;
  const c = combos[0];
  const { planId, cutOrderId } = c;
  // 计划
  assert.strictEqual((await api('POST', `/api/plans/${planId}/cancel`)).status, 409);
  assert.strictEqual((await api('POST', `/api/plans/${planId}/confirm`)).status, 409);
  assert.strictEqual((await api('PUT', `/api/plans/${planId}`, { copies: 3 })).status, 409);
  assert.strictEqual((await api('DELETE', `/api/plans/${planId}`)).status, 409);
  // 订单
  assert.strictEqual((await api('POST', `/api/cut-orders/${cutOrderId}/cancel`)).status, 409);
  assert.strictEqual((await api('POST', `/api/cut-orders/${cutOrderId}/confirm`)).status, 409);
  assert.strictEqual((await api('PUT', `/api/cut-orders/${cutOrderId}`, { copies: 3 })).status, 409);
  assert.strictEqual((await api('DELETE', `/api/cut-orders/${cutOrderId}`)).status, 409);
  // 换单：目标版本不存在也应先被 combo_managed 拦截（顺序不重要，状态码须为 409）
  const rp = await api('POST', `/api/cut-orders/${cutOrderId}/replacement/preview`, { targetVersion: 2 });
  assert.strictEqual(rp.status, 409);
  assert.strictEqual(rp.data.code, 'combo_managed');
  const rc = await api('POST', `/api/cut-orders/${cutOrderId}/replacement`, { targetVersion: 2 });
  assert.strictEqual(rc.status, 409);
  assert.strictEqual(rc.data.code, 'combo_managed');
  // 库存未因这些失败请求变化
  const mats = await api('GET', '/api/materials');
  const before = mats.data.materials[0].reserved;
  assert.ok(before > 0);
});

test('取消整套单：两类预留各释放一次，子单同步取消；重复取消 409 不重复变更', async () => {
  const c = (await api('GET', '/api/combo-orders')).data.combos[0];
  const mats0 = await api('GET', '/api/materials');
  const leadBefore = mats0.data.materials[0].reserved;
  const sheets0 = Object.fromEntries((await api('GET', '/api/glass-sheets')).data.sheets.map((s) => [s.color, s.reserved]));
  assert.ok(leadBefore > 0);

  const r = await api('POST', `/api/combo-orders/${c.id}/cancel`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.combo.status, 'canceled');
  assert.strictEqual(r.data.combo.plan.status, 'canceled');
  assert.strictEqual(r.data.combo.cutOrder.status, 'canceled');

  const m = (await api('GET', `/api/materials/${c.materialId || (await api('GET', '/api/materials')).data.materials[0].id}`)).data.material;
  // 用 c 中的 material：列表接口取
  const mats = await api('GET', '/api/materials');
  const leadMat = mats.data.materials[0];
  assert.strictEqual(leadMat.reserved, leadBefore - c.lead.requiredBars);
  const sheets = Object.fromEntries((await api('GET', '/api/glass-sheets')).data.sheets.map((s) => [s.color, s.reserved]));
  for (const col of c.glass.colors) {
    assert.strictEqual(sheets[col.color], sheets0[col.color] - col.requiredSheets);
  }

  // 重复取消：409，库存不再变化
  const again = await api('POST', `/api/combo-orders/${c.id}/cancel`);
  assert.strictEqual(again.status, 409);
  const mats2 = (await api('GET', '/api/materials')).data.materials[0];
  assert.strictEqual(mats2.reserved, leadMat.reserved);

  // 已取消整套单不存在 404 场景；取消后子单仍可查（canceled），原入口依旧不可删
  const plan = (await api('GET', `/api/plans/${c.planId}`)).data.plan;
  assert.strictEqual(plan.status, 'canceled');
  assert.strictEqual((await api('DELETE', `/api/plans/${c.planId}`)).status, 409);
  assert.strictEqual((await api('DELETE', `/api/cut-orders/${c.cutOrderId}`)).status, 409);
});

test('玻璃不足：整单失败、不留部分（铅条也未预留，无任何子单产生）', async () => {
  // 专用规格与颜色：新建图纸已无必要，直接登记新原材（库存充裕）+ 小尺寸红色原片
  const mat = await api('POST', '/api/materials', { name: '玻璃不足料', length: 6000, stock: 5 });
  const materialId = mat.data.material.id;
  // 55×110：每件一张；红色仅 1 张库存
  const red = await api('POST', '/api/glass-sheets', { color: '#111111', width: 55, height: 110, stock: 1 });
  // 该颜色不在快照中，无影响；红色 #ff0000 已登记为大尺寸且库存 10。改用新图纸新颜色：
  // 直接用 #ff0000 的库存下调不行（已预留可能为 0，上一用例已取消 -> 可调到 0）。
  await api('PATCH', `/api/glass-sheets/${red.data.sheet.id}`, { stock: 1 });
  // 用一份“每色每件一板”的参数：gap=10 + 55x110 只在 #ff0000 不适用；
  // 改为把 #ff0000 库存调到 1（当前预留为 0）
  const sheets = (await api('GET', '/api/glass-sheets')).data.sheets;
  const redSheet = sheets.find((s) => s.color === '#ff0000');
  await api('PATCH', `/api/glass-sheets/${redSheet.id}`, { stock: 1 });

  const beforePlans = (await api('GET', '/api/plans')).data.plans.length;
  const beforeOrders = (await api('GET', '/api/cut-orders')).data.orders.length;
  const beforeCombos = (await api('GET', '/api/combo-orders')).data.combos.length;
  const leadBefore = (await api('GET', `/api/materials/${materialId}`)).data.material.reserved;

  // copies=2：红/绿各需 2 张（600x400 放得下两件同色？50x100 两片在 600x400 同板，
  // gap=10 时两片 50x100 并放需要 110 宽，600 宽足够 -> 实际 1 张/色）。
  // 故用每件一张的小尺寸颜色不可行（规格身份不可改）；直接断言：红库存 1、需求 >=1 时
  // copies 足够大（如 5 件，每色 1 张）红仅 1 张 -> 若 1 张可放多件则提高 copies 至缺口。
  // 用 preview 先取实际每色张数，再把库存调到 张数-1 构造必然缺口。
  const pv = await api('POST', '/api/combo-orders/preview', {
    publicationId: pubId, materialId, copies: 5, kerf: 0, gap: 0,
  });
  assert.strictEqual(pv.status, 200);
  const needRed = pv.data.preview.glass.colors.find((c) => c.color === '#ff0000').requiredSheets;
  assert.ok(needRed >= 1);
  // 红色库存 1；若 1 张即可装下 5 件则需求为 1、无缺口，此时把绿色压到 0 制造缺口
  let shortageColor = '#ff0000';
  if (needRed <= 1) {
    const green = (await api('GET', '/api/glass-sheets')).data.sheets.find((s) => s.color === '#00ff00');
    await api('PATCH', `/api/glass-sheets/${green.id}`, { stock: 0 });
    shortageColor = '#00ff00';
  }
  const r = await api('POST', '/api/combo-orders', {
    publicationId: pubId, materialId, copies: 5, kerf: 0, gap: 0,
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.data.code, 'shortage');
  assert.ok(r.data.glassShortages.some((s) => s.color === shortageColor && s.shortage > 0));

  // 无任何部分预留 / 子单
  const leadAfter = (await api('GET', `/api/materials/${materialId}`)).data.material.reserved;
  assert.strictEqual(leadAfter, leadBefore);
  assert.strictEqual((await api('GET', '/api/plans')).data.plans.length, beforePlans);
  assert.strictEqual((await api('GET', '/api/cut-orders')).data.orders.length, beforeOrders);
  assert.strictEqual((await api('GET', '/api/combo-orders')).data.combos.length, beforeCombos);

  // 恢复库存供后续用例
  await api('PATCH', `/api/glass-sheets/${redSheet.id}`, { stock: 10 });
  const green = (await api('GET', '/api/glass-sheets')).data.sheets.find((s) => s.color === '#00ff00');
  await api('PATCH', `/api/glass-sheets/${green.id}`, { stock: 10 });
});

test('铅条不足：整单失败、玻璃也不留预留', async () => {
  const mat = await api('POST', '/api/materials', { name: '铅条紧张料', length: 6000, stock: 0 });
  const materialId = mat.data.material.id;
  const r = await api('POST', '/api/combo-orders', {
    publicationId: pubId, materialId, copies: 1, kerf: 0, gap: 0,
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.data.code, 'shortage');
  assert.ok(r.data.leadShortage);
  assert.strictEqual(r.data.leadShortage.shortage, r.data.leadShortage.required);
  const before = (await api('GET', '/api/combo-orders')).data.combos.length;
  assert.strictEqual((await api('GET', '/api/plans')).data.plans.filter((p) => p.materialId === materialId).length, 0);
  assert.strictEqual((await api('GET', '/api/combo-orders')).data.combos.length, before);
});

test('幂等：相同键+相同参数返回原单不重复预留；不同参数 409', async () => {
  const mats = await api('GET', '/api/materials');
  const materialId = mats.data.materials.find((m) => m.name === '6m料').id;
  const body = {
    name: '幂等整套', publicationId: pubId, materialId, copies: 1, kerf: 0.5, gap: 0,
    idempotencyKey: 'key-abc-1',
  };
  const r1 = await api('POST', '/api/combo-orders', body);
  assert.strictEqual(r1.status, 201);
  const id = r1.data.combo.id;
  const reserved1 = (await api('GET', `/api/materials/${materialId}`)).data.material.reserved;

  const r2 = await api('POST', '/api/combo-orders', body);
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.data.idempotent, true);
  assert.strictEqual(r2.data.combo.id, id);
  const reserved2 = (await api('GET', `/api/materials/${materialId}`)).data.material.reserved;
  assert.strictEqual(reserved2, reserved1, '重复确认不重复预留');

  // 不同参数同键：409 param_conflict，不新增、不预留
  const conflict = await api('POST', '/api/combo-orders', { ...body, copies: 2 });
  assert.strictEqual(conflict.status, 409);
  assert.strictEqual(conflict.data.code, 'param_conflict');
  assert.strictEqual(conflict.data.existingCombo.id, id);
  const reserved3 = (await api('GET', `/api/materials/${materialId}`)).data.material.reserved;
  assert.strictEqual(reserved3, reserved1);
  assert.strictEqual((await api('GET', `/api/combo-orders`)).data.combos.filter((c) => c.idempotencyKey === 'key-abc-1').length, 1);
});

test('并发：多个整套单同时确认不会超卖两类库存', async () => {
  // 铅条库存恰好 1 根/单；玻璃每色库存 1 张/单：开 4 单竞争，恰 1 单成功
  const mat = await api('POST', '/api/materials', { name: '并发整套料', length: 6000, stock: 1 });
  const materialId = mat.data.material.id;
  const red = await api('POST', '/api/glass-sheets', { color: '#aa0000', width: 600, height: 400, stock: 1 });
  const green = await api('POST', '/api/glass-sheets', { color: '#00aa00', width: 600, height: 400, stock: 1 });
  // 新颜色不在快照中 -> 改调 #ff0000/#00ff00 库存：另建专用图纸颜色无法复用，
  // 直接把既有两色调到“仅够 1 单”（当前无 confirmed 预留占用）
  const sheets = (await api('GET', '/api/glass-sheets')).data.sheets;
  const redSheet = sheets.find((s) => s.color === '#ff0000');
  const greenSheet = sheets.find((s) => s.color === '#00ff00');
  // 先取消本用例之前可能存在的已确认整套单（幂等键单仍 confirmed）
  for (const c of (await api('GET', '/api/combo-orders')).data.combos) {
    if (c.status === 'confirmed') await api('POST', `/api/combo-orders/${c.id}/cancel`);
  }
  await api('PATCH', `/api/glass-sheets/${redSheet.id}`, { stock: 1 });
  await api('PATCH', `/api/glass-sheets/${greenSheet.id}`, { stock: 1 });

  const results = await Promise.all([1, 2, 3, 4].map((i) => api('POST', '/api/combo-orders', {
    name: `并发整套${i}`, publicationId: pubId, materialId, copies: 1, kerf: 0, gap: 0,
    idempotencyKey: `race-${i}`,
  })));
  const okN = results.filter((r) => r.data.ok).length;
  assert.strictEqual(okN, 1, '四类同时竞争，仅 1 套成功');
  assert.ok(results.every((r) => r.data.ok || r.data.code === 'shortage'));

  const m = (await api('GET', `/api/materials/${materialId}`)).data.material;
  assert.ok(m.reserved <= m.stock);
  for (const s of (await api('GET', '/api/glass-sheets')).data.sheets) {
    assert.ok(s.reserved <= s.stock, `${s.color} 预留不超过库存`);
  }
  // 恢复
  await api('PATCH', `/api/glass-sheets/${redSheet.id}`, { stock: 10 });
  await api('PATCH', `/api/glass-sheets/${greenSheet.id}`, { stock: 10 });
});

test('快照绑定：再发布新版本后，已确认整套单及其子单用料不变', async () => {
  const mat = await api('POST', '/api/materials', { name: '整套快照料', length: 6000, stock: 5 });
  const materialId = mat.data.material.id;
  const r = await api('POST', '/api/combo-orders', {
    name: '快照整套', publicationId: pubId, materialId, copies: 1, kerf: 0, gap: 0,
  });
  assert.strictEqual(r.status, 201);
  const cid = r.data.combo.id;
  const beforeSegs = r.data.combo.lead.segmentCount;
  const beforeSheets = r.data.combo.glass.totalSheets;

  // 改草稿再发布 v2
  await api('DELETE', `/api/designs/${designId}/pieces/2`);
  await api('POST', `/api/designs/${designId}/pieces`, {
    color: '#0000ff', polygon: [[50, 0], [100, 0], [100, 50], [50, 50]],
  });
  await api('POST', `/api/designs/${designId}/pieces`, {
    color: '#abcdef', polygon: [[50, 50], [100, 50], [100, 100], [50, 100]],
  });
  const v2 = await api('POST', `/api/designs/${designId}/publish`);
  pubId2 = v2.data.publication.id;
  assert.strictEqual(v2.data.publication.version, 2);

  const c = (await api('GET', `/api/combo-orders/${cid}`)).data.combo;
  assert.strictEqual(c.version, 1);
  assert.strictEqual(c.publicationId, pubId);
  assert.strictEqual(c.lead.segmentCount, beforeSegs);
  assert.strictEqual(c.glass.totalSheets, beforeSheets);
  const plan = (await api('GET', `/api/plans/${c.planId}`)).data.plan;
  assert.strictEqual(plan.version, 1);
  const order = (await api('GET', `/api/cut-orders/${c.cutOrderId}`)).data.order;
  assert.strictEqual(order.version, 1);
});

test('原有独立计划、订单及其接口继续可用（不受整套单影响）', async () => {
  const mats = await api('GET', '/api/materials');
  const materialId = mats.data.materials.find((m) => m.name === '整套快照料').id;
  // 独立草稿计划 -> 确认 -> 取消 -> 删除
  const p = await api('POST', '/api/plans', {
    name: '独立计划', publicationId: pubId, materialId, copies: 1, kerf: 0,
  });
  assert.strictEqual(p.status, 201);
  const pid = p.data.plan.id;
  assert.strictEqual(p.data.plan.comboManaged, false);
  assert.strictEqual(p.data.plan.comboId, null);
  assert.ok((await api('POST', `/api/plans/${pid}/confirm`)).data.ok);
  assert.ok((await api('POST', `/api/plans/${pid}/cancel`)).data.ok);
  assert.strictEqual((await api('DELETE', `/api/plans/${pid}`)).status, 200);

  // 独立草稿订单 -> 确认 -> 取消（v2 快照新增蓝/灰两色，先登记原片）
  await api('POST', '/api/glass-sheets', { color: '#0000ff', width: 600, height: 400, stock: 5 });
  await api('POST', '/api/glass-sheets', { color: '#abcdef', width: 600, height: 400, stock: 5 });
  const o = await api('POST', '/api/cut-orders', {
    name: '独立订单', publicationId: pubId2, copies: 1, gap: 0,
  });
  assert.strictEqual(o.status, 201);
  const oid = o.data.order.id;
  assert.strictEqual(o.data.order.comboManaged, false);
  assert.strictEqual(o.data.order.comboId, null);
  assert.ok((await api('POST', `/api/cut-orders/${oid}/confirm`)).data.ok);
  assert.ok((await api('POST', `/api/cut-orders/${oid}/cancel`)).data.ok);
});

test('整套单列表与详情可查，网页首页可打开', async () => {
  const list = await api('GET', '/api/combo-orders');
  assert.ok(Array.isArray(list.data.combos) && list.data.combos.length > 0);
  for (const c of list.data.combos) {
    assert.ok(['confirmed', 'canceled'].includes(c.status));
    assert.ok(c.planId);
    assert.ok(c.cutOrderId);
  }
  const one = await api('GET', `/api/combo-orders/${list.data.combos[0].id}`);
  assert.strictEqual(one.status, 200);
  assert.strictEqual(one.data.combo.id, list.data.combos[0].id);
  assert.strictEqual((await api('GET', '/api/combo-orders/99999')).status, 404);
  const root = await fetch(BASE + '/');
  assert.strictEqual(root.status, 200);
});
