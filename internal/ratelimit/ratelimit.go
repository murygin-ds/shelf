// Package ratelimit implements per-key request rate limiting.
package ratelimit

import (
	"math"
	"slices"
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
// code, and behind a trusted proxy the client address itself — so a spray of distinct values
// would otherwise allocate a bucket apiece and grow without limit.
//
// At the cap the oldest buckets are evicted rather than new keys refused. Refusing is the
// tempting choice for a security control, but here it fails the wrong way: filling the map
// would deny every address and every account not already in it, which is a lockout of the
// whole service for the price of one spray. Eviction costs an attacker a full sweep of the
// map to clear one counter and never grants access to anything.
//
// A hundred thousand keys is far past any real deployment and costs a few megabytes.
const MaxKeys = 100_000

// evictBatch is how much room one eviction makes. Dropping a slice at a time keeps the
// O(n) sweep rare instead of running it on every request once the map is full.
const evictBatch = MaxKeys / 10

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
		l.evict(now)
	}

	b := l.bucket(key, now)
	if b.tokens < 1 {
		return false, time.Duration((1-b.tokens)/l.refillRate*float64(time.Second)) + time.Second
	}

	b.tokens--

	return true, 0
}

// size reports how many buckets are held. It exists for tests.
func (l *Limiter) size() int {
	l.mu.Lock()
	defer l.mu.Unlock()

	return len(l.buckets)
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

// evict makes room by dropping the least recently seen buckets.
//
// It runs one sweep and takes a batch, so the cost is amortised rather than paid on every
// request once the map is full. The buckets it drops are the ones whose owners have not
// been seen for longest, which are also the ones closest to having refilled anyway.
func (l *Limiter) evict(now time.Time) {
	// A cheap first pass: anything already fully refilled is indistinguishable from a new
	// bucket, so dropping it costs nothing at all.
	l.lastCleanup = time.Time{}
	l.cleanup(now)

	room := l.maxKeys - len(l.buckets)
	if room > 0 {
		return
	}

	// Otherwise take the oldest. One pass finds the cutoff, a second applies it: sorting
	// a hundred thousand keys on a request path would cost more than the memory it saves.
	oldest := make([]time.Time, 0, len(l.buckets))
	for _, b := range l.buckets {
		oldest = append(oldest, b.seen)
	}

	slices.SortFunc(oldest, func(a, b time.Time) int { return a.Compare(b) })

	cutoff := oldest[min(evictBatch, len(oldest)-1)]

	for key, b := range l.buckets {
		if !b.seen.After(cutoff) {
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
