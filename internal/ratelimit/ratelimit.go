// Package ratelimit implements per-key request rate limiting.
package ratelimit

import (
	"math"
	"sync"
	"time"
)

// Limiter is a token bucket per key: limit requests are allowed per window and
// tokens refill evenly instead of arriving in a batch at the end of the window.
//
// The state lives in process memory, so with several service instances the limit
// applies to each of them separately.
type Limiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket

	burst       float64
	refillRate  float64 // tokens per second
	idleTTL     time.Duration
	lastCleanup time.Time
	maxKeys     int
	now         func() time.Time
}

// MaxKeys bounds the map.
//
// Several of these limiters are keyed by something the caller chooses — a login, an invite
// code — so a spray of distinct values would otherwise allocate a bucket apiece and grow
// the map without limit. At the cap the limiter refuses new keys rather than forgetting old
// ones: resetting would hand an attacker a way to clear everybody's counters, and this is a
// security control, so it fails closed.
//
// A hundred thousand keys is far past any real deployment and costs a few megabytes.
const MaxKeys = 100_000

type bucket struct {
	tokens float64
	seen   time.Time
}

// New creates a limiter: limit requests per key within window.
func New(limit int, window time.Duration) *Limiter {
	now := time.Now()

	return &Limiter{
		buckets:     make(map[string]*bucket),
		burst:       float64(limit),
		refillRate:  float64(limit) / window.Seconds(),
		idleTTL:     window,
		lastCleanup: now,
		maxKeys:     MaxKeys,
		now:         time.Now,
	}
}

// Allow spends one attempt. The second value is how long to wait for the next one
// if the attempt was rejected.
func (l *Limiter) Allow(key string) (bool, time.Duration) {
	now := l.now()

	l.mu.Lock()
	defer l.mu.Unlock()

	l.cleanup(now)

	if _, known := l.buckets[key]; !known && len(l.buckets) >= l.maxKeys {
		// One more sweep before giving up: the gate above only lets cleanup run once per
		// window, and being at the cap is reason enough to run it again.
		l.lastCleanup = time.Time{}
		l.cleanup(now)

		if len(l.buckets) >= l.maxKeys {
			return false, l.idleTTL
		}
	}

	b := l.bucket(key, now)
	if b.tokens < 1 {
		return false, time.Duration((1-b.tokens)/l.refillRate*float64(time.Second)) + time.Second
	}

	b.tokens--

	return true, 0
}

// SetMaxKeys lowers the cap. It exists for tests: filling a hundred thousand buckets to
// check the boundary would be a slow way to learn nothing extra.
func (l *Limiter) SetMaxKeys(max int) {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.maxKeys = max
}

// Refund gives a spent attempt back: a successful request must not move a
// legitimate client closer to the limit.
func (l *Limiter) Refund(key string) {
	now := l.now()

	l.mu.Lock()
	defer l.mu.Unlock()

	b, ok := l.buckets[key]
	if !ok {
		return
	}

	b.tokens = math.Min(l.burst, b.tokens+1)
	b.seen = now
}

// bucket returns the bucket of the key, refilled for the elapsed time.
func (l *Limiter) bucket(key string, now time.Time) *bucket {
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: l.burst}
		l.buckets[key] = b
	} else {
		b.tokens = math.Min(l.burst, b.tokens+now.Sub(b.seen).Seconds()*l.refillRate)
	}

	b.seen = now

	return b
}

// cleanup drops fully refilled buckets: they are indistinguishable from new ones,
// and without it the map grows with the number of unique keys.
func (l *Limiter) cleanup(now time.Time) {
	if now.Sub(l.lastCleanup) < l.idleTTL {
		return
	}

	l.lastCleanup = now

	for key, b := range l.buckets {
		if b.tokens+now.Sub(b.seen).Seconds()*l.refillRate >= l.burst {
			delete(l.buckets, key)
		}
	}
}

// Nop limits nothing: it is substituted when limits are disabled in the configuration.
type Nop struct{}

// Allow always permits the request.
func (Nop) Allow(string) (bool, time.Duration) { return true, 0 }

// Refund does nothing.
func (Nop) Refund(string) {}
