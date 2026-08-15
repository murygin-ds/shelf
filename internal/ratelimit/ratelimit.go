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
	now         func() time.Time
}

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

	b := l.bucket(key, now)
	if b.tokens < 1 {
		return false, time.Duration((1-b.tokens)/l.refillRate*float64(time.Second)) + time.Second
	}

	b.tokens--

	return true, 0
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
