import { parseBooleanFlag } from '../../src/logic/conversion-task'

describe('parseBooleanFlag', () => {
  describe('when the raw value is undefined or empty', () => {
    it('should return the default', () => {
      expect(parseBooleanFlag(undefined, true)).toBe(true)
      expect(parseBooleanFlag(undefined, false)).toBe(false)
      expect(parseBooleanFlag('', true)).toBe(true)
      expect(parseBooleanFlag('', false)).toBe(false)
    })
  })

  describe('when the raw value is a known truthy string (any case)', () => {
    it.each(['true', 'TRUE', 'True', '1', 'yes', 'YES', 'on', 'ON'])(
      'should return true for %s',
      (raw) => {
        expect(parseBooleanFlag(raw, false)).toBe(true)
      }
    )
  })

  describe('when the raw value is a known falsy string (any case)', () => {
    it.each(['false', 'FALSE', 'False', '0', 'no', 'NO', 'off', 'OFF'])(
      'should return false for %s',
      (raw) => {
        expect(parseBooleanFlag(raw, true)).toBe(false)
      }
    )
  })

  describe('when the raw value has surrounding whitespace', () => {
    it('should still recognise the underlying keyword', () => {
      expect(parseBooleanFlag('  false  ', true)).toBe(false)
      expect(parseBooleanFlag('\ttrue\n', false)).toBe(true)
    })
  })

  describe('when the raw value is unrecognised', () => {
    it('should fall back to the default', () => {
      expect(parseBooleanFlag('maybe', true)).toBe(true)
      expect(parseBooleanFlag('maybe', false)).toBe(false)
      expect(parseBooleanFlag('2', true)).toBe(true)
    })
  })
})
