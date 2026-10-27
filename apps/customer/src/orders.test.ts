import { describe, expect, it } from 'vitest';
import { rollUpAdditions } from './orders.ts';

const o = (id: string, parentOrderId: string | null) => ({ id, parentOrderId, createdAt: '2026-10-26T00:00:00.000Z' });

describe('rollUpAdditions：加菜子单收回到父单', () => {
  it('子单排在父单前面（接口按时间倒序），收回来之后只剩父单', () => {
    // 真实顺序：刚加的子单最早出现
    const list = [o('sub1', 'root'), o('root', null)];
    expect(rollUpAdditions(list).map((x) => x.id)).toEqual(['root']);
  });

  it('多次加菜仍然只有一个父单', () => {
    const list = [o('sub2', 'root'), o('sub1', 'root'), o('root', null)];
    expect(rollUpAdditions(list).map((x) => x.id)).toEqual(['root']);
  });

  it('没有加菜时原样返回，顺序不变', () => {
    const list = [o('b', null), o('a', null)];
    expect(rollUpAdditions(list).map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('父单不在这一页（被 limit 截断）时保留子单，不能凭空吞掉一单', () => {
    const list = [o('sub1', 'gone-root')];
    expect(rollUpAdditions(list).map((x) => x.id)).toEqual(['sub1']);
  });

  it('父子单都被截断成部分时，各自的父单只出现一次', () => {
    const list = [o('sub1', 'root'), o('root', null), o('other', null)];
    expect(rollUpAdditions(list).map((x) => x.id)).toEqual(['root', 'other']);
  });

  it('空列表不炸', () => {
    expect(rollUpAdditions([])).toEqual([]);
  });
});
