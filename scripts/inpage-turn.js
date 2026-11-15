(function () {
  // Scheduled, not awaited: agent-browser eval must return immediately
  // (CDP awaitPromise times out long tests). Poll window.__done / __result.
  setTimeout(async () => {
    const out = {
      turnEntries: 0, relayCandidates: 0, candSamples: [], dcOpen: false, msgReceived: false,
      pair: null, pairs: [], sctp: null, readyState: null, iceState: null, connState: null, error: null,
    }
    const candA = []
    const candB = []
    try {
      const res = await fetch('/api/ice')
      const { iceServers } = await res.json()
      out.turnEntries = iceServers.filter((s) => s.urls.some((u) => u.startsWith('turn'))).length
      const mk = () => new RTCPeerConnection({ iceServers, iceTransportPolicy: 'relay' })

      const a = mk()
      const b = mk()
      window.__lastPc = a
      a.addEventListener('iceconnectionstatechange', () => { out.iceState = a.iceConnectionState })
      a.addEventListener('connectionstatechange', () => { out.connState = a.connectionState })
      const dc = a.createDataChannel('e2e')
      const onCand = (arr, other) => (e) => {
        if (e.candidate) {
          arr.push(e.candidate)
          if (arr.length <= 3) out.candSamples.push(e.candidate.candidate)
          other.addIceCandidate(e.candidate).catch(() => {})
        }
      }
      a.addEventListener('icecandidate', onCand(candA, b))
      b.addEventListener('icecandidate', onCand(candB, a))
      const dcB = new Promise((res) => b.addEventListener('datachannel', (e) => res(e.channel)))

      const offer = await a.createOffer()
      await a.setLocalDescription(offer)
      await b.setRemoteDescription(offer)
      const answer = await b.createAnswer()
      await b.setLocalDescription(answer)
      await a.setRemoteDescription(answer)
      const chanB = await dcB
      chanB.onmessage = (e) => { if (e.data === 'relay-ping') out.msgReceived = true }

      // readyState check FIRST: the 'open' event may already have fired
      // (A's channel opens when SCTP comes up, before B's datachannel event).
      await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`dc open timeout (15s), readyState=${dc.readyState}`)), 15000)
        const chk = () => { if (dc.readyState === 'open') { clearTimeout(t); res() } }
        dc.onopen = chk
        chk()
      })
      out.dcOpen = true
      out.readyState = dc.readyState
      dc.send('relay-ping')
      await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('message timeout (10s)')), 10000)
        const iv = setInterval(() => { if (out.msgReceived) { clearInterval(iv); clearTimeout(t); res() } }, 50)
      })
      out.sctp = a.sctp ? a.sctp.state : null
    } catch (e) {
      out.error = String((e && e.message) || e)
    }
    // Dump stats regardless of outcome — the timeout path must report the truth.
    try {
      const stats = await window.__lastPc.getStats()
      stats.forEach((s) => {
        if (s.type === 'candidate-pair') {
          const lc = stats.get(s.localCandidateId)
          const rc = stats.get(s.remoteCandidateId)
          const rec = { state: s.state, nominated: s.nominated, selected: s.selected, local: lc?.candidateType, remote: rc?.candidateType }
          if (s.selected) out.pair = rec
          out.pairs.push(rec)
        }
      })
      window.__lastPc.close()
    } catch (_) {}
    out.relayCandidates =
      candA.filter((c) => c.candidate.includes('typ relay')).length +
      candB.filter((c) => c.candidate.includes('typ relay')).length
    window.__result = out
    window.__done = true
  }, 0)
  return 'scheduled'
})()
