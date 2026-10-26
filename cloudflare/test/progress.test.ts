import test from 'node:test';
import assert from 'node:assert/strict';
import {partialSaveIntervalMs} from '../src/progress.ts';

test('partial saves default to one second and accept bounded overrides',()=>{
  assert.equal(partialSaveIntervalMs(),1000);
  for(const value of [1,100,1000,2500,60000]) {
    assert.equal(partialSaveIntervalMs(value),value);
    assert.equal(partialSaveIntervalMs(String(value)),value);
  }
});
test('invalid explicit partial-save intervals fail clearly rather than silently defaulting',()=>{
  for(const value of ['', ' ', '1.5', 'Infinity', 'NaN', '1e3', '-1', ' 1000 ', '60001', 0, -1, 1.5, Infinity, NaN, 60001]) {
    assert.throws(()=>partialSaveIntervalMs(value),/CUSE_PARTIAL_SAVE_INTERVAL_MS must be an integer from 1 to 60000/);
  }
});
