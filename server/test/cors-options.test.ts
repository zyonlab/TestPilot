import{expect,it,vi}from'vitest';import{trustedWebOrigin}from'../src/corsOptions.js';
it('permits local UI ports and explicit deployment origins without allowing lookalike origins',()=>{
 expect(trustedWebOrigin('http://localhost:5300')).toBe(true);expect(trustedWebOrigin('http://127.0.0.1:8080')).toBe(true);expect(trustedWebOrigin('http://localhost.evil.test:5300')).toBe(false);expect(trustedWebOrigin('null')).toBe(false);vi.stubEnv('TP_WEB_ORIGINS','https://app.example.test');expect(trustedWebOrigin('https://app.example.test')).toBe(true);expect(trustedWebOrigin('https://elsewhere.test')).toBe(false);vi.unstubAllEnvs();
});
