package ratelimit

import (
	"sync"
	"testing"
	"time"
)

// at replaces the limiter clock so the tests do not have to sleep.
func at(l *Limiter, now *time.Time) {
	l.now = func() time.Time { return *now }
}

func TestAllowExhaustsAndRefills(t *testing.T) {
	t.Parallel()

	now := time.Now()
	limiter := New(3, time.Minute)
	at(limiter, &now)

	for i := range 3 {
		if ok, _ := limiter.Allow("ip"); !ok {
			t.Fatalf("attempt %d was rejected within the limit", i+1)
		}
	}

	ok, retryAfter := limiter.Allow("ip")
	if ok {
		t.Fatal("Allow() = true, want false past the limit")
	}

	if retryAfter <= 0 {
		t.Fatalf("retryAfter = %v, want a positive delay", retryAfter)
	}

	// Another key is counted separately.
	if ok, _ := limiter.Allow("other-ip"); !ok {
		t.Fatal("Allow() = false for a fresh key")
	}

	// A third of the window refills one token out of three.
	now = now.Add(20 * time.Second)

	if ok, _ := limiter.Allow("ip"); !ok {
		t.Fatal("Allow() = false after a token was refilled")
	}

	if ok, _ := limiter.Allow("ip"); ok {
		t.Fatal("Allow() = true, only one token should have been refilled")
	}

	now = now.Add(time.Minute)

	for i := range 3 {
		if ok, _ := limiter.Allow("ip"); !ok {
			t.Fatalf("attempt %d was rejected after a full window", i+1)
		}
	}
}

func TestRefundReturnsAttempt(t *testing.T) {
	t.Parallel()

	now := time.Now()
	limiter := New(2, time.Minute)
	at(limiter, &now)

	limiter.Allow("key")
	limiter.Refund("key")

	for i := range 2 {
		if ok, _ := limiter.Allow("key"); !ok {
			t.Fatalf("attempt %d was rejected after a refund", i+1)
		}
	}

	// Refund does not pour above the limit.
	limiter.Refund("key")
	limiter.Refund("key")
	limiter.Refund("key")

	if ok, _ := limiter.Allow("key"); !ok {
		t.Fatal("Allow() = false right after a refund")
	}

	if ok, _ := limiter.Allow("key"); !ok {
		t.Fatal("Allow() = false, two refunds should have restored the burst")
	}

	if ok, _ := limiter.Allow("key"); ok {
		t.Fatal("Allow() = true, refunds exceeded the burst")
	}
}

func TestCleanupDropsIdleKeys(t *testing.T) {
	t.Parallel()

	now := time.Now()
	limiter := New(1, time.Minute)
	at(limiter, &now)

	limiter.Allow("first")

	now = now.Add(2 * time.Minute)
	limiter.Allow("second")

	limiter.mu.Lock()
	defer limiter.mu.Unlock()

	if _, ok := limiter.buckets["first"]; ok {
		t.Error("idle bucket survived the cleanup")
	}

	if _, ok := limiter.buckets["second"]; !ok {
		t.Error("active bucket was dropped")
	}
}

func TestConcurrentAllowKeepsLimit(t *testing.T) {
	t.Parallel()

	limiter := New(50, time.Hour)

	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		allowed int
	)

	for range 200 {
		wg.Add(1)

		go func() {
			defer wg.Done()

			if ok, _ := limiter.Allow("key"); ok {
				mu.Lock()
				allowed++
				mu.Unlock()
			}
		}()
	}

	wg.Wait()

	if allowed != 50 {
		t.Fatalf("allowed = %d, want 50", allowed)
	}
}
