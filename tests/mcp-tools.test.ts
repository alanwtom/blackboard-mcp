import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createBlackboardServer } from '../src/index.js';
import { globalCache } from '../src/blackboard/cache.js';
import type { BBHttp } from '../src/blackboard/session.js';
import { FakeHttp, installDefaultRoutes } from './helpers/fake-http.js';

beforeAll(() => {
  process.env.BLACKBOARD_MCP_HOME = path.join(os.tmpdir(), `bb-mcp-mcp-${process.pid}-${Date.now()}`);
});

beforeEach(() => {
  globalCache.clear();
});

interface Connected {
  client: Client;
  server: McpServer;
  http: FakeHttp;
}

async function connect(): Promise<Connected> {
  const http = new FakeHttp();
  installDefaultRoutes(http);
  const callBB = async <T>(fn: (h: BBHttp) => Promise<T>): Promise<T> => fn(http);
  const server = createBlackboardServer(callBB);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server, http };
}

describe('blackboard-mcp server', () => {
  it('advertises all nine read-only tools', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'get_announcements',
      'get_assignment_context',
      'get_assignments',
      'get_attachment',
      'get_course_content',
      'get_grades',
      'get_recent_updates',
      'get_upcoming_work',
      'list_courses',
    ]);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('list_courses returns normalized courses through the real domain layer', async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'list_courses', arguments: {} });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    const data = JSON.parse(text) as { count: number; courses: Array<{ name: string }> };
    expect(data.count).toBe(1);
    expect(data.courses[0].name).toContain('CIS 473');
  });

  it('get_grades returns the student’s own grades', async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'get_grades', arguments: { course_id: '_26184_1' } });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    const data = JSON.parse(text) as { grades: Array<{ title: string; score: number | null }> };
    expect(data.grades[0].title).toBe('Problem Set 1');
    expect(data.grades[0].score).toBe(88);
  });

  it('get_announcements returns normalized announcements', async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'get_announcements', arguments: { course_id: '_26184_1' } });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    const data = JSON.parse(text) as { announcements: Array<{ title: string; body: string }> };
    expect(data.announcements[0].title).toBe('Welcome to CIS 473');
    expect(data.announcements[0].body).toContain('Office hours');
  });

  it('get_upcoming_work returns assignments sorted by due date', async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'get_upcoming_work', arguments: { days: 30 } });
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    const data = JSON.parse(text) as { count: number; items: Array<{ title: string; due_date: string }> };
    expect(data.count).toBe(1);
    expect(data.items[0].title).toBe('Problem Set 1');
    expect(data.items[0].due_date).toBe('2026-09-05T23:59:00.000Z');
  });

  it('get_assignment_context bundles instructions, attachments, grade, and announcements', async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: 'get_assignment_context',
      arguments: { assignment_id: '_26184_1:_3010_1' },
    });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    const data = JSON.parse(text) as {
      assignment: { title: string; due_date: string; points_possible: number };
      attachments: Array<{ file_id: string | null }>;
      grade: { score: number | null };
      related_announcements: Array<{ title: string }>;
    };
    expect(data.assignment.title).toBe('Problem Set 1');
    expect(data.assignment.points_possible).toBe(100);
    expect(data.grade.score).toBe(88);
    expect(data.attachments).toHaveLength(0);
    expect(data.related_announcements[0].title).toBe('Welcome to CIS 473');
  });

  it('validates arguments and rejects invalid input', async () => {
    const { client } = await connect();

    const missing = await client.callTool({ name: 'get_grades', arguments: {} });
    expect(missing.isError).toBe(true);
    const missingText = (missing.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(missingText).toMatch(/course_id|invalid/i);

    const noCourse = await client.callTool({
      name: 'get_assignment_context',
      arguments: { assignment_id: '_3010_1' },
    });
    expect(noCourse.isError).toBe(true);
    const noCourseText = (noCourse.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(noCourseText).toContain('INVALID_INPUT');
  });

  it('surfaces coded errors instead of raw HTML or stack traces', async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'get_grades', arguments: { course_id: '_missing_1' } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    expect(text).toContain('COURSE_NOT_FOUND');
    expect(text).not.toContain('<html');
  });
});
