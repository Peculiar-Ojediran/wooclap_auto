import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { applyImageInteraction, extractImageInteraction, snapshotImageInteraction, verifyImageInteraction } from '../src/content/image-interactions';
import type { AdvancedQuestion } from '../src/content/advanced';
import type { Answer } from '../src/shared/types';
import { fingerprint } from '../src/shared/core';

const html = readFileSync(new URL('./fixtures/image-participant.html', import.meta.url), 'utf8');
interface Fixture { show(type: string): void; values: Record<string, string | { x: number; y: number }>; submissionCount: number; delay: number; ignoreInput: boolean; close(): void; movePin(number: number, x: number, y: number): void }
function setup(t: TestContext, type: string) {
  const dom = new JSDOM(html, { url: 'https://app.wooclap.com/event/IMAGE', runScripts: 'dangerously', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const win = dom.window, doc = win.document;
  Object.defineProperties(win.HTMLImageElement.prototype, { complete: { configurable: true, get: () => true }, naturalWidth: { configurable: true, get: () => 400 }, naturalHeight: { configurable: true, get: () => 200 } });
  // jsdom has no layout. Supply the same CSS geometry that Edge computes for
  // this fixture; browser replay separately exercises real bounding rectangles.
  win.HTMLElement.prototype.getBoundingClientRect = function () {
    let x = 100, y = 100, width = 400, height = 200;
    const img = doc.querySelector('img');
    if (img?.style.width) width = parseFloat(img.style.width);
    if (this.matches('main')) { x = 80; y = 20; width = 600; height = 600; }
    const pin = this.matches('.pin') ? this : this.closest('.pin');
    if (pin) { x += parseFloat((pin as HTMLElement).style.left) - 20; y += parseFloat((pin as HTMLElement).style.top) - 20; width = 40; height = 40; }
    return { x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON: () => ({}) } as DOMRect;
  };
  const fixture = (win as unknown as { imageFixture: Fixture }).imageFixture; fixture.show(type);
  const read = () => extractImageInteraction(doc.querySelector('main')!, doc.querySelector('h1')!, 'event/IMAGE', doc)!;
  const live = (): AdvancedQuestion => { const r = read(); assert.ok('controls' in r, 'detail' in r ? r.detail : 'No controls'); return r; };
  return { dom, doc, fixture, read, live };
}
const captions: Answer = { selectedChoiceIds: [], values: [{ id: 'marker-1', value: 'Circle' }, { id: 'marker-2', value: 'Rectangle' }], explanation: '', needsReview: false };
const locations: Answer = { selectedChoiceIds: [], points: [{ id: 'item-1', x: .25, y: .3 }, { id: 'item-2', x: .75, y: .7 }], explanation: '', needsReview: false };
const point: Answer = { selectedChoiceIds: [], points: [{ id: 'point-1', x: .25, y: .3 }], explanation: '', needsReview: false };

test('image captions open numbered controlled fields, reopen to verify, and leave final submit to caller', async t => {
  const { live, fixture, doc } = setup(t, 'LabelAnImage'); const q = live().question;
  assert.equal(q.application, 'automatic'); assert.deepEqual(q.fields?.map(f => f.id), ['marker-1', 'marker-2']);
  await applyImageInteraction(q, captions, live);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.values)), { 1: 'Circle', 2: 'Rectangle' });
  assert.equal(verifyImageInteraction(live(), captions), true);
  assert.equal(fingerprint(live().question), fingerprint(q));
  assert.equal(fixture.submissionCount, 0);
  doc.querySelector<HTMLButtonElement>('[data-test-id="Participant.Submit"]')!.click(); assert.equal(fixture.submissionCount, 1);
});
test('image captions reject a changed current caption immediately before submission', async t => {
  const { live, doc } = setup(t, 'LabelAnImage'); await applyImageInteraction(live().question, captions, live);
  doc.querySelector<HTMLInputElement>('input')!.value = 'Other';
  assert.equal(verifyImageInteraction(live(), captions), false);
});
test('image captions fail when input events do not persist in controlled state', async t => {
  const { live, fixture } = setup(t, 'LabelAnImage'); fixture.ignoreInput = true;
  await assert.rejects(applyImageInteraction(live().question, captions, live), /retain/);
  assert.equal(fixture.submissionCount, 0);
});
test('image captions include fixed marker locations in identity and reject additional comments', t => {
  const { live, read, doc } = setup(t, 'LabelAnImage'); const initial = fingerprint(live().question);
  doc.querySelector<HTMLElement>('.pin')!.style.left = '120px'; assert.notEqual(fingerprint(live().question), initial);
  doc.querySelector('main')!.insertAdjacentHTML('beforeend', '<textarea></textarea>'); assert.equal('controls' in read(), false);
});
test('find-on-image dispatches client coordinates and verifies retained draft pin before standard submission', async t => {
  const { live, fixture } = setup(t, 'ShowOnImage'); const before = snapshotImageInteraction(live());
  await applyImageInteraction(live().question, point, live);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.values)), { 1: { x: 100, y: 60 } });
  assert.equal(verifyImageInteraction(live(), point), true); assert.notEqual(snapshotImageInteraction(live()), before);
  assert.equal(fixture.submissionCount, 0);
});
test('find-on-image distinguishes a submitted pin from an editable draft pin', async t => {
  const { live, doc } = setup(t, 'ShowOnImage'); await applyImageInteraction(live().question, point, live);
  doc.querySelector('.delete')!.remove(); assert.equal(verifyImageInteraction(live(), point), false);
});
test('drag-and-drop uses select then image mouse-down and window mouse-up with async commits', async t => {
  const { live, fixture, dom, doc } = setup(t, 'DragAndDrop'); const q = live().question;
  // A click alone on the surface is intentionally ineffective: the fixture
  // reproduces the public component's mouse-down/window-mouse-up state machine.
  doc.querySelector('.surface')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, clientX: 200, clientY: 160 }));
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.values)), {});
  await applyImageInteraction(q, locations, live);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.values)), { 1: { x: 100, y: 60 }, 2: { x: 300, y: 140 } });
  assert.equal(verifyImageInteraction(live(), locations), true); assert.equal(fingerprint(live().question), fingerprint(q)); assert.equal(fixture.submissionCount, 0);
});
test('drag-and-drop corrects existing draft placements using the public reposition path', async t => {
  const { live, fixture } = setup(t, 'DragAndDrop'); fixture.movePin(1, 150, 130); fixture.movePin(2, 230, 60);
  await applyImageInteraction(live().question, locations, live); assert.equal(verifyImageInteraction(live(), locations), true);
});
test('placement verification rejects a moved pin before submission', async t => {
  const { live, fixture } = setup(t, 'DragAndDrop'); await applyImageInteraction(live().question, locations, live);
  fixture.movePin(1, 110, 60); assert.equal(verifyImageInteraction(live(), locations), false);
});
test('placement snapshot changes when rendered image geometry changes', t => {
  const { live, doc } = setup(t, 'DragAndDrop'); const before = snapshotImageInteraction(live());
  doc.querySelector('img')!.style.width = '500px'; assert.notEqual(snapshotImageInteraction(live()), before);
});
test('placement stops on image resizing between mouse-down and window mouse-up', async t => {
  const { live, doc, fixture } = setup(t, 'DragAndDrop');
  setTimeout(() => { doc.querySelector('img')!.style.width = '500px'; }, 110);
  await assert.rejects(applyImageInteraction(live().question, locations, live), /geometry changed/);
  assert.equal(fixture.submissionCount, 0);
});
test('placement rejects letterboxing, CSS transforms, extra fields, and ambiguous labels', t => {
  const { read, doc, fixture } = setup(t, 'DragAndDrop');
  const img = doc.querySelector('img')!; img.style.objectFit = 'contain'; img.style.width = '500px'; assert.equal('controls' in read(), false);
  fixture.show('DragAndDrop'); doc.querySelector('img')!.style.transform = 'scale(.5)'; assert.equal('controls' in read(), false);
  fixture.show('DragAndDrop'); doc.querySelector('main')!.insertAdjacentHTML('beforeend', '<input>'); assert.equal('controls' in read(), false);
  fixture.show('DragAndDrop'); doc.querySelectorAll('h6')[1].previousElementSibling!.textContent = '1'; assert.equal('controls' in read(), false);
});
test('placement cancellation after selecting first item prevents every placement and final submission', async t => {
  const { live, fixture } = setup(t, 'DragAndDrop'); let active = true; setTimeout(() => { active = false; }, 20);
  await assert.rejects(applyImageInteraction(live().question, locations, live, () => { if (!active) throw new Error('Paused'); }), /Paused/);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.values)), {}); assert.equal(fixture.submissionCount, 0);
});
test('placement question closure aborts before a pending pointer release', async t => {
  const { live, read, fixture } = setup(t, 'DragAndDrop'); const q = live().question; setTimeout(() => fixture.close(), 110);
  await assert.rejects(applyImageInteraction(q, locations, read), /changed/); assert.equal(fixture.submissionCount, 0);
});
test('exact-boundary coordinates are rejected because public renderer suppresses zero positions', async t => {
  const { live, fixture } = setup(t, 'ShowOnImage');
  await assert.rejects(applyImageInteraction(live().question, { ...point, points: [{ id: 'point-1', x: 0, y: .4 }] }, live), /boundary/);
  assert.equal(fixture.submissionCount, 0);
});

test('image interaction rejects meaningful ARIA-hidden SVG without confusing marker decoration', t => {
  const { live, read, doc } = setup(t, 'LabelAnImage');
  assert.equal(live().question.application, 'automatic');
  doc.querySelector('main')!.insertAdjacentHTML('beforeend', '<svg aria-hidden="true" viewBox="0 0 160 160"><circle cx="80" cy="80" r="40"/></svg>');
  assert.equal('controls' in read(), false);
});

test('multiple draft pins for the same image label never verify as one placement', async t => {
  const { live, doc } = setup(t, 'ShowOnImage'); await applyImageInteraction(live().question, point, live);
  const pin = doc.querySelector('.pin')!; pin.parentElement!.append(pin.cloneNode(true), pin.cloneNode(true));
  assert.equal(verifyImageInteraction(live(), point), false);
});
