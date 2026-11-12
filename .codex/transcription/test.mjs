import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from './core.mjs';
test('до пяти минут, включая границу, выбирается Groq',async()=>{
  for (const seconds of [1,300]) assert.equal((await route(seconds,{groq:async()=>({text:'ok'}),deepgram:async()=>assert.fail()})).provider,'groq');
});
test('длинная запись сразу идёт в Deepgram',async()=>{
  assert.equal((await route(301,{groq:async()=>assert.fail(),deepgram:async()=>({text:'ok'})})).provider,'deepgram');
});
test('сбой Groq переключает на Deepgram',async()=>{
  const r=await route(20,{groq:async()=>{throw new Error('timeout')},deepgram:async()=>({text:'ok'})});
  assert.equal(r.fallback,true); assert.equal(r.provider,'deepgram');
});
test('сбой обоих возвращает ошибку',async()=>{
  await assert.rejects(route(20,{groq:async()=>{throw Error('groq')},deepgram:async()=>{throw Error('deepgram')}}),/deepgram/);
});
