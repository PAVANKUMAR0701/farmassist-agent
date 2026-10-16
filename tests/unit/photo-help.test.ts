import { describe, expect, it } from 'vitest';
import { composeAnswer, forTheSameCropOrAnimal, parseObservation, photoHelp, type Observation, type VisionModel } from '../../src/agent/photo-help.js';
import { handleChatRequest, type ChatAppDeps } from '../../src/chat/app.js';
import { InMemoryConversationStore } from '../../src/chat/conversations.js';
import { InMemoryPhotoStore, looksLike, type PhotoStore } from '../../src/chat/photos.js';
import { REFERENCE_NOTES } from '../../src/knowledge/corpus.js';
import { KeywordRetriever } from '../../src/knowledge/retrieval.js';

const note = (id: string) => REFERENCE_NOTES.find((n) => n.id === id)!;
const seen = (o: Partial<Observation>): Observation => ({ subject: 'crop', what: 'paddy leaves', visibleSigns: [], urgentSigns: [], photoQuality: 'good', confidence: 'medium', ...o });
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const fakeVision = (o: Observation | Error): VisionModel => ({ modelId: 'fake', observe: async () => (o instanceof Error ? Promise.reject(o) : o) });

describe('parseObservation', () => {
  it('reads JSON wrapped in text or code fences, and falls back to "unclear" for anything else', () => {
    expect(parseObservation('Here you go:\n```json\n{"subject":"animal","what":"cow mouth","visibleSigns":["drooling"],"urgentSigns":[],"photoQuality":"good","confidence":"high"}\n```')).toMatchObject({
      subject: 'animal',
      visibleSigns: ['drooling'],
    });
    expect(parseObservation('I think it is a sick cow')).toMatchObject({ subject: 'unclear', photoQuality: 'poor', visibleSigns: [] });
    expect(parseObservation('{"subject":"dragon","confidence":"total"}')).toMatchObject({ subject: 'unclear', confidence: 'low' });
  });
});

describe('composeAnswer', () => {
  it('describes, hedges, gives the note\'s first steps and when to escalate, and never claims a diagnosis', () => {
    const answer = composeAnswer(seen({ visibleSigns: ['grey eye-shaped spots'] }), [{ note: note('paddy-blast'), score: 5 }], { keywordScores: true });
    expect(answer.reply).toContain('What I can see: grey eye-shaped spots.');
    expect(answer.reply).toContain('This can look like Paddy blast');
    expect(answer.reply).toContain('I cannot be sure from a photo.');
    expect(answer.reply).toContain(note('paddy-blast').escalate);
    expect(answer.reply).toMatch(/not a diagnosis\.$/);
    expect(answer).toMatchObject({ urgent: false, notifiable: false, needsBetterPhoto: false });
  });

  it('a disease that must be reported is always urgent and says to call the vet today', () => {
    const answer = composeAnswer(seen({ subject: 'animal', what: 'cow mouth', visibleSigns: ['drooling', 'sores on the tongue'] }), [{ note: note('cattle-fmd'), score: 6 }], { keywordScores: true });
    expect(answer).toMatchObject({ urgent: true, notifiable: true });
    expect(answer.reply).toContain(note('cattle-fmd').escalate); // its own words say it must be reported, and when
    expect(answer.reply.match(/must be reported/g)).toHaveLength(1);
  });

  it('urgent signs come first, even with no matching note', () => {
    const answer = composeAnswer(seen({ subject: 'animal', what: 'cow', urgentSigns: ['lying down and unable to rise'] }), []);
    expect(answer.reply).toMatch(/^This looks urgent: lying down and unable to rise\. Call the veterinarian now\./);
    expect(answer.reply).toContain('could not match this to a problem');
    expect(answer.urgent).toBe(true);
  });

  it('asks for a better photo instead of guessing, and drops weak keyword matches', () => {
    expect(composeAnswer(seen({ subject: 'unclear' }), [{ note: note('paddy-blast'), score: 9 }])).toMatchObject({ needsBetterPhoto: true, matches: [] });
    expect(composeAnswer(seen({ photoQuality: 'poor' }), [])).toMatchObject({ needsBetterPhoto: true });
    const weak = composeAnswer(seen({ visibleSigns: ['green leaves'] }), [{ note: note('paddy-blast'), score: 0.5 }], { keywordScores: true });
    expect(weak.matches).toEqual([]);
    expect(weak.reply).toContain('could not match');
  });
});

describe('forTheSameCropOrAnimal', () => {
  it('keeps notes for the crop the farmer or photo names (live: ragi blast was offered for paddy)', () => {
    const matches = [{ note: note('ragi-blast'), score: 4 }, { note: note('paddy-blast'), score: 3 }];
    expect(forTheSameCropOrAnimal(matches, 'my paddy leaves').map((m) => m.note.id)).toEqual(['paddy-blast']);
    expect(forTheSameCropOrAnimal(matches, 'my leaves').map((m) => m.note.id)).toEqual(['ragi-blast', 'paddy-blast']);
  });
});

describe('photoHelp', () => {
  it('finds the matching note from what the photo shows', async () => {
    const vision = fakeVision(seen({ subject: 'animal', what: 'cow udder', visibleSigns: ['one quarter of the udder is swollen', 'clots in the milk'] }));
    const answer = await photoHelp({ vision, retriever: new KeywordRetriever() }, { bytes: JPEG, format: 'jpeg' });
    expect(answer.matches[0]!.id).toBe('cattle-mastitis');
  });

  it('when the vision model fails, uses the farmer\'s words and says the photo was not read', async () => {
    const answer = await photoHelp({ vision: fakeVision(new Error('ThrottlingException')), retriever: new KeywordRetriever() }, { bytes: JPEG, format: 'jpeg' }, 'blisters between the hooves and drooling', 'animal');
    expect(answer.reply).toMatch(/^I could not look at the photo right now/);
    expect(answer.matches[0]!.id).toBe('cattle-fmd');
    expect(answer.notifiable).toBe(true);
  });
});

describe('POST /api/photo', () => {
  const user = { userId: 'u1', farmId: 'farm-1', name: 'Asha' };
  const deps = (photos: PhotoStore = new InMemoryPhotoStore(), vision?: VisionModel): ChatAppDeps => ({
    auth: { authenticate: async (h) => (h === 'Bearer ok' ? user : undefined) },
    conversations: new InMemoryConversationStore(),
    toolsFor: () => ({ listTools: async () => [], callTool: async () => ({ isError: false, text: '' }) }),
    assets: {},
    publicConfig: { auth: 'dev' },
    photos,
    vision,
    now: () => new Date('2026-10-17T06:30:00Z'),
  });
  const send = (d: ChatAppDeps, body: unknown, token = 'ok') =>
    handleChatRequest(new Request('https://x/api/photo', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }), d);
  const image = Buffer.from(JPEG).toString('base64');

  it('stores the photo for the user\'s farm and answers', async () => {
    const photos = new InMemoryPhotoStore();
    const vision = fakeVision(seen({ visibleSigns: ['eye-shaped grey spots on the leaves'] }));
    const res = await send(deps(photos, vision), { image: `data:image/jpeg;base64,${image}`, format: 'jpeg', note: 'my paddy' });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.photoId).toMatch(/^photos\/farm-1\/2026-10-17\/[0-9A-Z]{26}\.jpg$/);
    expect(photos.photos.size).toBe(1);
    expect(body.matches[0].id).toBe('paddy-blast');
  });

  it('refuses unsigned requests, wrong file types, empty and oversized photos', async () => {
    const d = deps();
    expect((await send(d, { image, format: 'jpeg' }, 'bad')).status).toBe(401);
    expect((await send(d, { image, format: 'gif' })).status).toBe(400);
    expect((await send(d, { image: Buffer.from('hello, not a png').toString('base64'), format: 'png' })).status).toBe(400);
    expect((await send(d, { image: '', format: 'jpeg' })).status).toBe(400);
    expect((await send(d, { image: Buffer.alloc(1_600_000, 0xff).toString('base64'), format: 'jpeg' })).status).toBe(400);
  });

  it('still answers when the photo cannot be stored', async () => {
    const broken: PhotoStore = { put: async () => Promise.reject(new Error('AccessDenied')) };
    const res = await send(deps(broken, fakeVision(seen({ visibleSigns: ['small brown dots on the leaves'] }))), { image, format: 'jpeg' });
    expect(res.status).toBe(200);
    expect((await res.json()).photoId).toBeUndefined();
  });
});

it('looksLike checks the first bytes of each image type', () => {
  expect(looksLike(JPEG, 'jpeg')).toBe(true);
  expect(looksLike(JPEG, 'png')).toBe(false);
  expect(looksLike(new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')]), 'webp')).toBe(true);
});
