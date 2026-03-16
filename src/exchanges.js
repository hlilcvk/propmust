/** AGENT CONFIG: Exchange definitions — 7 exchanges */

const EXCHANGES = {
  BINANCE: {
    name: 'BINANCE', tag: 'BNB', priority: 1,
    rest: 'https://fapi.binance.com',
    klines: (s, i, l) => `/fapi/v1/klines?symbol=${s}&interval=${i}&limit=${l}`,
    ticker24h: () => '/fapi/v1/ticker/24hr',
    funding: () => '/fapi/v1/premiumIndex',
    oi: (s) => `/fapi/v1/openInterest?symbol=${s}`,
    info: () => '/fapi/v1/exchangeInfo',
    intervals: { '1m':'1m','5m':'5m','15m':'15m','1h':'1h','4h':'4h' },
    parseKline: k => ({ t:k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5], qv:+k[7] }),
    parseTicker: t => ({ symbol:t.symbol, price:+t.lastPrice, ch:+t.priceChangePercent, vol24:+t.quoteVolume, hi:+t.highPrice, lo:+t.lowPrice }),
    parseFunding: r => ({ symbol:r.symbol, rate:+r.lastFundingRate, mark:+r.markPrice }),
    parseOI: d => +d.openInterest,
    parseSymbols: d => d.symbols.filter(s => s.contractType==='PERPETUAL' && s.quoteAsset==='USDT' && s.status==='TRADING').map(s => s.symbol),
    tradeUrl: s => `https://www.binance.com/en/futures/${s}`
  },
  BYBIT: {
    name: 'BYBIT', tag: 'BYBIT', priority: 2,
    rest: 'https://api.bybit.com',
    klines: (s, i, l) => `/v5/market/kline?category=linear&symbol=${s}&interval=${i}&limit=${l}`,
    ticker24h: () => '/v5/market/tickers?category=linear',
    funding: () => '/v5/market/tickers?category=linear',
    oi: (s) => `/v5/market/open-interest?category=linear&symbol=${s}&intervalTime=5min&limit=1`,
    info: () => '/v5/market/instruments-info?category=linear&status=Trading',
    intervals: { '1m':'1','5m':'5','15m':'15','1h':'60','4h':'240' },
    parseKline: k => ({ t:+k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5] }),
    parseTickers: d => (d.result?.list||[]).map(t => ({ symbol:t.symbol, price:+t.lastPrice, ch:+t.price24hPcnt*100, vol24:+t.turnover24h, fund:+t.fundingRate })),
    parseOI: d => +(d.result?.list?.[0]?.openInterest||0),
    parseSymbols: d => (d.result?.list||[]).filter(s=>s.quoteCoin==='USDT').map(s=>s.symbol),
    tradeUrl: s => `https://www.bybit.com/trade/usdt/${s.replace('USDT','')}USDT`
  },
  OKX: {
    name: 'OKX', tag: 'OKX', priority: 3,
    rest: 'https://www.okx.com',
    klines: (s, i, l) => `/api/v5/market/candles?instId=${s.replace('USDT','-USDT-SWAP')}&bar=${i}&limit=${l}`,
    ticker24h: () => '/api/v5/market/tickers?instType=SWAP',
    funding: () => '/api/v5/public/funding-rate?instType=SWAP',
    oi: (s) => `/api/v5/public/open-interest?instType=SWAP&instId=${s.replace('USDT','-USDT-SWAP')}`,
    info: () => '/api/v5/public/instruments?instType=SWAP',
    intervals: { '1m':'1m','5m':'5m','15m':'15m','1h':'1H','4h':'4H' },
    parseKline: k => ({ t:+k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5] }),
    parseTickers: d => (d.data||[]).filter(t=>t.instId.endsWith('-USDT-SWAP')).map(t => ({ symbol:t.instId.replace('-USDT-SWAP','USDT'), price:+t.last, ch:t.open24h>0?((+t.last - +t.open24h)/+t.open24h*100):0, vol24:+t.volCcy24h })),
    parseFundings: d => (d.data||[]).map(r => ({ symbol:r.instId.replace('-USDT-SWAP','USDT'), rate:+r.fundingRate })),
    parseSymbols: d => (d.data||[]).filter(i=>i.instId.endsWith('-USDT-SWAP')).map(i=>i.instId.replace('-USDT-SWAP','USDT')),
    tradeUrl: s => `https://www.okx.com/trade-swap/${s.replace('USDT','').toLowerCase()}-usdt-swap`
  },
  BITGET: {
    name: 'BITGET', tag: 'BITGET', priority: 4,
    rest: 'https://api.bitget.com',
    klines: (s, i, l) => `/api/v2/mix/market/candles?productType=USDT-FUTURES&symbol=${s}&granularity=${i}&limit=${l}`,
    ticker24h: () => '/api/v2/mix/market/tickers?productType=USDT-FUTURES',
    funding: () => '/api/v2/mix/market/current-fund-rate?productType=USDT-FUTURES',
    oi: (s) => `/api/v2/mix/market/open-interest?productType=USDT-FUTURES&symbol=${s}`,
    info: () => '/api/v2/mix/market/contracts?productType=USDT-FUTURES',
    intervals: { '1m':'1m','5m':'5m','15m':'15m','1h':'1h','4h':'4h' },
    tradeUrl: s => `https://www.bitget.com/futures/usdt/${s}`
  },
  MEXC: {
    name: 'MEXC', tag: 'MEXC', priority: 5,
    rest: 'https://contract.mexc.com',
    ticker24h: () => '/api/v1/contract/ticker',
    info: () => '/api/v1/contract/detail',
    intervals: { '1m':'Min1','5m':'Min5','15m':'Min15','1h':'Min60','4h':'Hour4' },
    tradeUrl: s => `https://www.mexc.com/futures/exchange/${s}`
  },
  GATE: {
    name: 'GATE', tag: 'GATE', priority: 6,
    rest: 'https://api.gateio.ws',
    klines: (s, i, l) => `/api/v4/futures/usdt/candlesticks?contract=${s.replace('USDT','_USDT')}&interval=${i}&limit=${l}`,
    ticker24h: () => '/api/v4/futures/usdt/tickers',
    info: () => '/api/v4/futures/usdt/contracts',
    intervals: { '1m':'1m','5m':'5m','15m':'15m','1h':'1h','4h':'4h' },
    tradeUrl: s => `https://www.gate.io/futures_trade/USDT/${s.replace('USDT','_USDT')}`
  },
  KUCOIN: {
    name: 'KUCOIN', tag: 'KUCOIN', priority: 7,
    rest: 'https://api-futures.kucoin.com',
    ticker24h: () => '/api/v1/allTickers',
    info: () => '/api/v1/contracts/active',
    intervals: { '1m':1,'5m':5,'15m':15,'1h':60,'4h':240 },
    tradeUrl: s => `https://www.kucoin.com/futures/trade/${s.replace('USDT','USDTM')}`
  }
};

const ALL_EXCHANGES = Object.values(EXCHANGES);
const PRIMARY = EXCHANGES.BINANCE;

const SECTORS = {
  ai: ['FETUSDT','RNDRUSDT','TAOUSDT','ARKMUSDT','WLDUSDT','NEARUSDT','GRTUSDT','AIUSDT'],
  meme: ['DOGEUSDT','SHIBUSDT','PEPEUSDT','BONKUSDT','FLOKIUSDT','WIFUSDT','BOMEUSDT'],
  gaming: ['AXSUSDT','SANDUSDT','MANAUSDT','GALAUSDT','IMXUSDT','ENJUSDT'],
  l1: ['BTCUSDT','ETHUSDT','SOLUSDT','ADAUSDT','AVAXUSDT','DOTUSDT','SUIUSDT','APTUSDT','SEIUSDT','TONUSDT'],
  l2: ['ARBUSDT','OPUSDT','MATICUSDT','STRKUSDT','ZKUSDT'],
  defi: ['UNIUSDT','AAVEUSDT','MKRUSDT','CRVUSDT','GMXUSDT','PENDLEUSDT','LDOUSDT'],
  infra: ['LINKUSDT','ICPUSDT','FILUSDT','ARUSDT','TIAUSDT','INJUSDT'],
  rwa: ['ONDOUSDT','PENDLEUSDT','CFGUSDT']
};

const SYM_TO_SECTOR = {};
for (const [sec, syms] of Object.entries(SECTORS)) {
  for (const s of syms) SYM_TO_SECTOR[s] = sec;
}

module.exports = { EXCHANGES, ALL_EXCHANGES, PRIMARY, SECTORS, SYM_TO_SECTOR };
