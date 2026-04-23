import { parseBooleanFlag } from '../../src/logic/conversion-task'

describe('when parsing a boolean flag env var', () => {
  describe('and the raw value is undefined or empty', () => {
    it('should return the default', () => {
      expect(parseBooleanFlag(undefined, true)).toBe(true)
      expect(parseBooleanFlag(undefined, false)).toBe(false)
      expect(parseBooleanFlag('', true)).toBe(true)
      expect(parseBooleanFlag('', false)).toBe(false)
    })
  })

  describe('and the raw value is a known truthy string (any case)', () => {
    it.each(['true', 'TRUE', 'True', '1', 'yes', 'YES', 'on', 'ON'])(
      'should return true for %s',
      (raw) => {
        expect(parseBooleanFlag(raw, false)).toBe(true)
      }
    )
  })

  describe('and the raw value is a known falsy string (any case)', () => {
    it.each(['false', 'FALSE', 'False', '0', 'no', 'NO', 'off', 'OFF'])(
      'should return false for %s',
      (raw) => {
        expect(parseBooleanFlag(raw, true)).toBe(false)
      }
    )
  })

  describe('and the raw value has surrounding whitespace', () => {
    it('should still recognise the underlying keyword', () => {
      expect(parseBooleanFlag('  false  ', true)).toBe(false)
      expect(parseBooleanFlag('\ttrue\n', false)).toBe(true)
    })
  })

  describe('and the raw value is unrecognised', () => {
    it('should fall back to the default', () => {
      expect(parseBooleanFlag('maybe', true)).toBe(true)
      expect(parseBooleanFlag('maybe', false)).toBe(false)
      expect(parseBooleanFlag('2', true)).toBe(true)
    })

    describe('and an onUnrecognized callback is provided', () => {
      let onUnrecognized: jest.Mock

      beforeEach(() => {
        onUnrecognized = jest.fn()
      })

      afterEach(() => {
        jest.clearAllMocks()
      })

      it('should invoke the callback with the original raw value so operators see the typo in logs', () => {
        parseBooleanFlag('flase', true, onUnrecognized)
        expect(onUnrecognized).toHaveBeenCalledTimes(1)
        expect(onUnrecognized).toHaveBeenCalledWith('flase')
      })

      it('should NOT invoke the callback for recognised truthy/falsy values', () => {
        parseBooleanFlag('true', false, onUnrecognized)
        parseBooleanFlag('FALSE', true, onUnrecognized)
        parseBooleanFlag('1', false, onUnrecognized)
        expect(onUnrecognized).not.toHaveBeenCalled()
      })

      it('should NOT invoke the callback for unset or empty values (default behaviour, not a mistake)', () => {
        parseBooleanFlag(undefined, true, onUnrecognized)
        parseBooleanFlag('', false, onUnrecognized)
        expect(onUnrecognized).not.toHaveBeenCalled()
      })
    })
  })
})
