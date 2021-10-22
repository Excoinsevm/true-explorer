import { sanitize, getProvider} from '@/lib/utils.js';
const Web3 = require('web3');

describe('sanitize', () => {
    it('Should clear null keys', () => {
        const obj = {
            a: 1,
            b: null,
        };
        expect(sanitize(obj)).toEqual({ a: 1 });
    });
});

describe('getProvider', () => {
    it('Should return a websocket provider when ws url', () => {
        const provider = getProvider('ws://localhost:8545');
        expect(provider instanceof Web3.providers.WebsocketProvider).toBe(true);
    });

    it('Should return a websocket provider when wss url', () => {
        const provider = getProvider('wss://localhost:8545');
        expect(provider instanceof Web3.providers.WebsocketProvider).toBe(true);
    });

    it('Should return a http provider when http url', () => {
        const provider = getProvider('http://localhost:8545');
        expect(provider instanceof Web3.providers.HttpProvider).toBe(true);
    });

    it('Should return a http provider when https url', () => {
        const provider = getProvider('https://localhost:8545');
        expect(provider instanceof Web3.providers.HttpProvider).toBe(true);
    });
});