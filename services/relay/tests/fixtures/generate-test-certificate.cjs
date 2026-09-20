'use strict'

const crypto = require('node:crypto')
const forge = require('node-forge')

const keys = forge.pki.rsa.generateKeyPair(2048)
const certificate = forge.pki.createCertificate()
certificate.publicKey = keys.publicKey
certificate.serialNumber = crypto.randomBytes(16).toString('hex').replace(/^0+/, '') || '1'
certificate.validity.notBefore = new Date(Date.now() - 60_000)
certificate.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1_000)
certificate.setSubject([{ name: 'commonName', value: '127.0.0.1' }])
certificate.setIssuer(certificate.subject.attributes)
certificate.setExtensions([
  { name: 'basicConstraints', cA: true },
  { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
  { name: 'extKeyUsage', serverAuth: true },
  { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] },
])
certificate.sign(keys.privateKey, forge.md.sha256.create())

process.stdout.write(JSON.stringify({
  key: forge.pki.privateKeyToPem(keys.privateKey),
  certificate: forge.pki.certificateToPem(certificate),
}))
