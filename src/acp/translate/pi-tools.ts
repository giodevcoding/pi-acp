import type { ToolKind } from '@agentclientprotocol/sdk'

export function toToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case 'read':
      return 'read'
    case 'write':
    case 'edit':
      return 'edit'
    case 'bash':
      return 'execute'
    case 'grep':
    case 'find':
    case 'ls':
      return 'search'
    default:
      return 'other'
  }
}

function argString(args: unknown, key: string): string | undefined {
  const value = (args as Record<string, unknown> | null | undefined)?.[key]
  return typeof value === 'string' ? value : undefined
}

function toolTitleFor(toolName: string, args: unknown): string {
  const path = argString(args, 'path') ?? argString(args, 'file_path')

  switch (toolName) {
    case 'read':
    case 'write':
    case 'edit':
      return path ?? toolName
    case 'grep':
    case 'find': {
      const pattern = argString(args, 'pattern')
      if (!pattern) return toolName
      const scope = path ?? argString(args, 'glob')
      return scope ? `${pattern} in ${scope}` : pattern
    }
    case 'ls':
      return path ?? '.'
    default:
      return toolName
  }
}

/** One-line title for ACP tool calls, derived from pi tool args when available. */
export function toolTitle(toolName: string, args: unknown): string {
  return toolTitleFor(toolName, args).replace(/\s+/g, ' ').trim()
}

export function toolResultToText(result: unknown): string {
  if (!result) return ''

  const details = (result as any)?.details

  // pi's edit tool returns a terse success message in content and the full unified diff in details.diff.
  const diff = details?.diff
  if (typeof diff === 'string' && diff.trim()) {
    return diff
  }

  // pi tool results generally look like: { content: [{type:"text", text:"..."}], details: {...} }
  const content = (result as any).content
  if (Array.isArray(content)) {
    const texts = content
      .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
    if (texts.length) return texts.join('')
  }

  // The bash tool frequently returns stdout/stderr in `details` rather than content blocks.
  const stdout =
    (typeof details?.stdout === 'string' ? details.stdout : undefined) ??
    (typeof (result as any)?.stdout === 'string' ? (result as any).stdout : undefined) ??
    (typeof details?.output === 'string' ? details.output : undefined) ??
    (typeof (result as any)?.output === 'string' ? (result as any).output : undefined)

  const stderr =
    (typeof details?.stderr === 'string' ? details.stderr : undefined) ??
    (typeof (result as any)?.stderr === 'string' ? (result as any).stderr : undefined)

  const exitCode =
    (typeof details?.exitCode === 'number' ? details.exitCode : undefined) ??
    (typeof (result as any)?.exitCode === 'number' ? (result as any).exitCode : undefined) ??
    (typeof details?.code === 'number' ? details.code : undefined) ??
    (typeof (result as any)?.code === 'number' ? (result as any).code : undefined)

  if ((typeof stdout === 'string' && stdout.trim()) || (typeof stderr === 'string' && stderr.trim())) {
    const parts: string[] = []
    if (typeof stdout === 'string' && stdout.trim()) parts.push(stdout)
    if (typeof stderr === 'string' && stderr.trim()) parts.push(`stderr:\n${stderr}`)
    if (typeof exitCode === 'number') parts.push(`exit code: ${exitCode}`)
    return parts.join('\n\n').trimEnd()
  }

  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}
