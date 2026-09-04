import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function createSession(cwd = process.cwd()) {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  return { conn, proc }
}

async function settle() {
  await new Promise(r => setTimeout(r, 0))
}

test('PiAcpSession: attributes extension select to the in-flight edit tool call', async () => {
  const { conn, proc } = createSession()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'allow_once' } }

  const args = { path: 'hello.txt', edits: [{ oldText: 'a', newText: 'b' }] }
  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'edit', args })
  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-1',
    method: 'select',
    title: '🔒 edit: hello.txt',
    options: ['Allow once', 'Deny']
  })

  await settle()

  assert.equal(conn.permissionRequests.length, 1)
  const request = conn.permissionRequests[0] as any
  assert.equal(request.toolCall.toolCallId, 't1')
  assert.equal(request.toolCall.title, '🔒 edit: hello.txt')
  assert.equal(request.toolCall.kind, 'edit')
  assert.equal(request.toolCall.status, 'pending')
  assert.deepEqual(request.toolCall.rawInput, args)
  assert.deepEqual(request.options, [
    { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' }
  ])
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-1', value: 'Allow once' }])
})

test('PiAcpSession: maps rejected edit permission back to the pi deny option', async () => {
  const { conn, proc } = createSession()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'reject_once' } }

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'hello.txt', edits: [{ oldText: 'a', newText: 'b' }] }
  })
  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-1',
    method: 'select',
    title: '🔒 edit: hello.txt',
    options: ['Allow once', 'Deny']
  })

  await settle()

  assert.deepEqual((conn.permissionRequests[0] as any).toolCall.toolCallId, 't1')
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-1', value: 'Deny' }])
})

test('PiAcpSession: sends cancelled pi response when attributed permission is cancelled', async () => {
  const { conn, proc } = createSession()
  conn.nextPermissionResponse = { outcome: { outcome: 'cancelled' } }

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'write',
    args: { path: 'hello.txt', content: 'b' }
  })
  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-1',
    method: 'select',
    title: '🔒 write: hello.txt',
    options: ['Allow once', 'Deny']
  })

  await settle()

  assert.equal((conn.permissionRequests[0] as any).toolCall.toolCallId, 't1')
  assert.equal((conn.permissionRequests[0] as any).toolCall.kind, 'edit')
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-1', cancelled: true }])
})

test('PiAcpSession: keeps synthetic pi-ui tool call for selects outside an in-flight edit', async () => {
  const { conn, proc } = createSession()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'choice-1' } }

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'hello.txt', edits: [{ oldText: 'a', newText: 'b' }] }
  })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { content: [{ type: 'text', text: 'ok' }] }
  })
  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-1',
    method: 'select',
    title: 'Pick one',
    options: ['Alpha', 'Beta']
  })

  await settle()

  assert.equal(conn.permissionRequests.length, 1)
  const request = conn.permissionRequests[0] as any
  assert.equal(request.toolCall.toolCallId, 'pi-ui-ui-1')
  assert.equal(request.toolCall.kind, 'other')
  assert.deepEqual(request.options, [
    { optionId: 'choice-0', name: 'Alpha', kind: 'allow_once' },
    { optionId: 'choice-1', name: 'Beta', kind: 'allow_once' }
  ])
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-1', value: 'Beta' }])
})

test('PiAcpSession: attributes extension confirm to the in-flight edit tool call', async () => {
  const { conn, proc } = createSession()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'yes' } }

  const args = { path: 'hello.txt', edits: [{ oldText: 'a', newText: 'b' }] }
  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'edit', args })
  proc.emit({ type: 'extension_ui_request', id: 'ui-2', method: 'confirm', title: '🔒 edit: hello.txt' })

  await settle()

  assert.equal(conn.permissionRequests.length, 1)
  const request = conn.permissionRequests[0] as any
  assert.equal(request.toolCall.toolCallId, 't1')
  assert.equal(request.toolCall.title, '🔒 edit: hello.txt')
  assert.equal(request.toolCall.kind, 'edit')
  assert.deepEqual(request.toolCall.rawInput, args)
  assert.deepEqual(request.options, [
    { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
    { optionId: 'no', name: 'No', kind: 'reject_once' }
  ])
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-2', confirmed: true }])
})

test('PiAcpSession: attributes permission request with edit locations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-perm-'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'hello.txt'), 'a\n', 'utf8')
  const { conn, proc } = createSession(dir)

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'hello.txt', edits: [{ oldText: 'a', newText: 'b' }] }
  })
  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-1',
    method: 'select',
    title: '🔒 edit: hello.txt',
    options: ['Allow once', 'Deny']
  })

  await settle()

  assert.deepEqual((conn.permissionRequests[0] as any).toolCall.locations, [{ path: join(dir, 'hello.txt'), line: 1 }])
})
