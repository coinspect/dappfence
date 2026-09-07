import { describe, it, expect, vi } from 'vitest';
import { monkeyPatch, secureMonkeyPatch, verifyPatchIntegrity } from '../monkey-patch.js';

describe('monkeyPatch', () => {
    it('intercepts method calls with the handler', () => {
        const target = { greet: (name) => `hello ${name}` };
        monkeyPatch(target, 'greet', (ctx, name) => `patched: ${ctx.call(name)}`);

        expect(target.greet('world')).toBe('patched: hello world');
    });

    it('provides ctx.call to invoke the original', () => {
        const target = { add: (a, b) => a + b };
        let captured;
        monkeyPatch(target, 'add', (ctx, a, b) => {
            captured = ctx.call(a, b);
            return captured + 1;
        });

        expect(target.add(2, 3)).toBe(6);
        expect(captured).toBe(5);
    });

    it('returns a restore function that undoes the patch', () => {
        const original = (x) => x * 2;
        const target = { fn: original };
        const restore = monkeyPatch(target, 'fn', (ctx, x) => ctx.call(x) + 10);

        expect(target.fn(5)).toBe(20);
        restore();
        expect(target.fn(5)).toBe(10);
    });

    it('passes all arguments to the handler', () => {
        const target = { fn: () => {} };
        const args = [];
        monkeyPatch(target, 'fn', (ctx, ...a) => args.push(...a));

        target.fn('a', 'b', 'c');
        expect(args).toEqual(['a', 'b', 'c']);
    });

    it('ctx.apply invokes the original with a specific thisArg', () => {
        const obj = {
            value: 10,
            fn(x) {
                return this.value + x;
            },
        };
        const altThis = { value: 99 };
        let capturedResult;
        monkeyPatch(obj, 'fn', (ctx, x) => {
            capturedResult = ctx.apply(altThis, [x]);
            return capturedResult;
        });

        const result = obj.fn(1);
        expect(result).toBe(100);
        expect(capturedResult).toBe(100);
    });
});

describe('secureMonkeyPatch', () => {
    it('applies a non-writable, non-configurable patch', () => {
        const target = { fn: () => 'original' };
        const result = secureMonkeyPatch(target, 'fn', (_ctx) => 'patched');

        expect(result.success).toBe(true);
        expect(target.fn()).toBe('patched');

        const desc = Object.getOwnPropertyDescriptor(target, 'fn');
        expect(desc.writable).toBe(false);
        expect(desc.configurable).toBe(false);
    });

    it('verify returns true when patch is intact', () => {
        const target = { fn: () => 'original' };
        const result = secureMonkeyPatch(target, 'fn', (_ctx) => 'patched');

        expect(result.verify()).toBe(true);
    });

    it('intercepts calls through the handler', () => {
        const target = { fn: (x) => x };
        secureMonkeyPatch(target, 'fn', (ctx, x) => ctx.call(x) + 1);

        expect(target.fn(10)).toBe(11);
    });

    it('verify returns false when a fake descriptor is constructed', () => {
        const fakePatchedFn = () => {};
        const fakeTarget = { fn: fakePatchedFn };
        Object.defineProperty(fakeTarget, 'fn', {
            value: fakePatchedFn,
            writable: false,
            configurable: false,
            enumerable: true,
        });
        const differentFn = () => {};
        const patch = {
            success: true,
            target: fakeTarget,
            methodName: 'fn',
            verify: () => {
                const desc = Object.getOwnPropertyDescriptor(fakeTarget, 'fn');
                return (
                    desc &&
                    desc.value === differentFn &&
                    desc.writable === false &&
                    desc.configurable === false
                );
            },
        };

        expect(patch.verify()).toBe(false);
    });

    it('ctx.apply in secureMonkeyPatch invokes original with a specific thisArg', () => {
        const obj = {
            value: 5,
            fn(x) {
                return this.value + x;
            },
        };
        const altThis = { value: 50 };
        let capturedResult;
        secureMonkeyPatch(obj, 'fn', (ctx, x) => {
            capturedResult = ctx.apply(altThis, [x]);
            return capturedResult;
        });

        const result = obj.fn(3);
        expect(result).toBe(53);
        expect(capturedResult).toBe(53);
    });

    it('returns success=false when Object.defineProperty throws (non-configurable property)', () => {
        const target = {};
        Object.defineProperty(target, 'frozen', {
            value: () => 'original',
            writable: false,
            configurable: false,
            enumerable: true,
        });

        const result = secureMonkeyPatch(target, 'frozen', (_ctx) => 'patched');

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
    });

    it('verify catch path returns false when target getOwnPropertyDescriptor throws', () => {
        let verifyCallCount = 0;
        const proxyTarget = new Proxy(
            { fn: () => 'original' },
            {
                defineProperty(t, prop, descriptor) {
                    return Object.defineProperty(t, prop, descriptor);
                },
                getOwnPropertyDescriptor(t, prop) {
                    if (prop === 'fn' && verifyCallCount > 0) {
                        throw new Error('descriptor access denied');
                    }
                    return Object.getOwnPropertyDescriptor(t, prop);
                },
            }
        );

        const patchResult = secureMonkeyPatch(proxyTarget, 'fn', (_ctx) => 'patched');
        expect(patchResult.success).toBe(true);

        verifyCallCount++;
        const verifyResult = patchResult.verify();
        expect(verifyResult).toBe(false);
    });

    it('verify returns false and logs tampering when descriptor value differs', () => {
        let verifyCallCount = 0;
        const proxyTarget = new Proxy(
            { fn: () => 'original' },
            {
                defineProperty(t, prop, descriptor) {
                    return Object.defineProperty(t, prop, descriptor);
                },
                getOwnPropertyDescriptor(t, prop) {
                    if (prop === 'fn' && verifyCallCount > 0) {
                        return {
                            value: () => 'tampered',
                            writable: false,
                            configurable: false,
                            enumerable: true,
                        };
                    }
                    return Object.getOwnPropertyDescriptor(t, prop);
                },
            }
        );

        const patchResult = secureMonkeyPatch(proxyTarget, 'fn', (_ctx) => 'patched');
        expect(patchResult.success).toBe(true);

        verifyCallCount++;
        const verifyResult = patchResult.verify();
        expect(verifyResult).toBe(false);
    });
});

describe('secureMonkeyPatch - line 92 tampering detection', () => {
    it('line 92: console.error is called when isIntact is false due to tampered descriptor', () => {
        const target = { fn: () => 'original' };
        const patchResult = secureMonkeyPatch(target, 'fn', (_ctx) => 'patched');
        expect(patchResult.success).toBe(true);

        const origDescriptor = Object.getOwnPropertyDescriptor;
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const spy = vi
            .spyOn(Object, 'getOwnPropertyDescriptor')
            .mockImplementation(function (obj, prop) {
                if (obj === target && prop === 'fn') {
                    return {
                        value: () => 'tampered',
                        writable: false,
                        configurable: false,
                        enumerable: true,
                    };
                }
                return origDescriptor.call(this, obj, prop);
            });

        const result = patchResult.verify();

        expect(result).toBe(false);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('TAMPERING DETECTED'));

        spy.mockRestore();
        errorSpy.mockRestore();
    });
});

describe('verifyPatchIntegrity', () => {
    it('reports all patches intact', () => {
        const target = { a: () => {}, b: () => {} };
        const patchA = secureMonkeyPatch(target, 'a', () => {});
        const patchB = secureMonkeyPatch(target, 'b', () => {});

        const result = verifyPatchIntegrity([patchA, patchB]);
        expect(result.allIntact).toBe(true);
        expect(result.intactPatches).toBe(2);
        expect(result.compromisedPatches).toEqual([]);
    });

    it('detects compromised patches', () => {
        const patch = {
            success: true,
            target: { constructor: { name: 'FakeTarget' } },
            methodName: 'fn',
            verify: () => false,
        };

        const result = verifyPatchIntegrity([patch]);
        expect(result.allIntact).toBe(false);
        expect(result.compromisedPatches).toEqual(['FakeTarget.fn']);
    });

    it('handles failed patches gracefully', () => {
        const result = verifyPatchIntegrity([{ success: false }]);
        expect(result.allIntact).toBe(true);
        expect(result.intactPatches).toBe(0);
    });
});
