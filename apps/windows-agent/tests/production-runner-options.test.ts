import { describe, expect, it } from 'vitest'

import {
  parseProductionRunnerOptions,
  ProductionRunnerOptionsError,
} from '../src/production-runner-options.ts'

const projectRoot = 'C:\\Projects\\codex-plus'

describe('production runner options', () => {
  it('derives every runtime path inside the one workspace', () => {
    expect(parseProductionRunnerOptions([
      '--origin', 'https://gateway.example.com',
      '--codex-executable', 'C:\\Tools\\codex.exe',
      '--workspace', 'C:\\Projects\\CODEX-PLUS\\',
    ], projectRoot)).toEqual({
      origin: 'https://gateway.example.com',
      webSocketUrl: 'wss://gateway.example.com/api/ws',
      codexExecutable: 'C:\\Tools\\codex.exe',
      workspaceRoot: 'C:\\Projects\\codex-plus',
      stateDirectory: 'C:\\Projects\\codex-plus\\.data\\windows-companion',
      temporaryDirectory: 'C:\\Projects\\codex-plus\\.tmp\\windows-companion',
      identityFile: 'C:\\Projects\\codex-plus\\.data\\windows-companion\\identity.dpapi',
      actionDatabase: 'C:\\Projects\\codex-plus\\.data\\windows-companion\\action.sqlite',
      actionAnchor: 'C:\\Projects\\codex-plus\\.data\\windows-companion\\action.sqlite.anchor.dpapi',
      attachmentDirectory: 'C:\\Projects\\codex-plus\\.data\\windows-companion\\attachments',
      pairingQrFile: 'C:\\Projects\\codex-plus\\.tmp\\windows-companion\\pairing.png',
      bootstrapExportFile: 'C:\\Projects\\codex-plus\\.tmp\\windows-companion\\relay-bootstrap',
    })
  })

  it.each([
    ['http origin', ['--origin', 'http://gateway.example.com', '--codex-executable', 'C:\\Tools\\codex.exe', '--workspace', projectRoot]],
    ['origin path', ['--origin', 'https://gateway.example.com/path', '--codex-executable', 'C:\\Tools\\codex.exe', '--workspace', projectRoot]],
    ['foreign workspace', ['--origin', 'https://gateway.example.com', '--codex-executable', 'C:\\Tools\\codex.exe', '--workspace', 'C:\\Projects\\other']],
    ['relative executable', ['--origin', 'https://gateway.example.com', '--codex-executable', 'codex.exe', '--workspace', projectRoot]],
    ['non-exe command', ['--origin', 'https://gateway.example.com', '--codex-executable', 'C:\\Tools\\codex.cmd', '--workspace', projectRoot]],
    ['UNC executable', ['--origin', 'https://gateway.example.com', '--codex-executable', '\\\\server\\codex.exe', '--workspace', projectRoot]],
    ['duplicate option', ['--origin', 'https://gateway.example.com', '--origin', 'https://other.example', '--codex-executable', 'C:\\Tools\\codex.exe', '--workspace', projectRoot]],
  ])('rejects %s', (_name, argv) => {
    expect(() => parseProductionRunnerOptions(argv, projectRoot)).toThrow(ProductionRunnerOptionsError)
  })
})
