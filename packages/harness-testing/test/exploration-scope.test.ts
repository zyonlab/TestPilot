import { describe,it,expect } from 'vitest';
import { sameExplorationPage } from '../src/exec/explorationScope.js';
describe('current URL exploration boundary',()=>{
  it('allows symbol and other query values without expanding the path',()=>{
    expect(sameExplorationPage('https://trade.test/trade?symbol=BTC','https://trade.test/trade?symbol=ETH&mode=perp')).toBe(true);
    expect(sameExplorationPage('https://trade.test/trade','/trade#orders')).toBe(true);
    for(const url of ['/portfolio','/trade/BTC','https://other.test/trade','http://trade.test/trade','https://trade.test:8080/trade']) expect(sameExplorationPage('https://trade.test/trade',url)).toBe(false);
  });
  it('keeps hash-router pages distinct while allowing hash queries',()=>{
    expect(sameExplorationPage('https://trade.test/#/trade?symbol=BTC','https://trade.test/#/trade?symbol=ETH')).toBe(true);
    expect(sameExplorationPage('https://trade.test/#/trade','https://trade.test/#/portfolio')).toBe(false);
    expect(sameExplorationPage('https://trade.test/trade','https://trade.test/trade#/portfolio')).toBe(false);
  });
});
it('allows only explicitly configured parameterized page routes',()=>{
 const templates=['/trade/:symbol'];
 for(const path of ['/trade/ETH','/trade/BTC?mode=limit','/trade'])expect(sameExplorationPage('https://trade.test/trade',path,templates)).toBe(true);
 for(const path of ['/portfolio','/trade/ETH/orders','https://other.test/trade/ETH'])expect(sameExplorationPage('https://trade.test/trade',path,templates)).toBe(false);
 expect(sameExplorationPage('https://trade.test/trade/ETH','/trade/BTC',templates)).toBe(true);
});
