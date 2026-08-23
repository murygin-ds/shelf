package response_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"shelf/internal/api/response"

	"github.com/gin-gonic/gin"
	"github.com/gin-gonic/gin/binding"
)

// encoding/json describes a malformed body by naming the Go type it was decoding into.
// That tells the caller nothing they can act on and tells an attacker the shape of the
// server, so it belongs in the log rather than in the answer.
func TestAMalformedBodyDoesNotNameGoTypes(t *testing.T) {
	gin.SetMode(gin.TestMode)

	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodPost, "/", strings.NewReader("{}"))

	var target struct {
		Count int `json:"count"`
	}

	err := json.Unmarshal([]byte(`{"count":"not a number"}`), &target)
	if err == nil {
		t.Fatal("expected the fixture to produce an unmarshal error")
	}

	response.FailValidation(c, err)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}

	body := rec.Body.String()

	for _, leak := range []string{"struct", "Go value", "int"} {
		if strings.Contains(body, leak) {
			t.Fatalf("the response names an internal (%q): %s", leak, body)
		}
	}
}

// The reason travels in the same details map as the validation fields, so the two must not
// be able to name the same key. Validator field names come from the Go struct and are
// exported, which is what keeps a lower-case reason out of their way.
func TestReasonCannotCollideWithAValidationField(t *testing.T) {
	gin.SetMode(gin.TestMode)

	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodPost, "/", nil)

	type payload struct {
		Reason string `binding:"required" json:"reason"`
	}

	err := binding.Validator.ValidateStruct(&payload{})
	if err == nil {
		t.Fatal("expected the fixture to fail validation")
	}

	response.FailValidation(c, err)

	var body response.ErrorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal %s: %v", rec.Body, err)
	}

	if _, taken := body.Error.Details[response.ReasonKey]; taken {
		t.Fatalf("a validated field claimed %q: %v", response.ReasonKey, body.Error.Details)
	}

	if _, ok := body.Error.Details["Reason"]; !ok {
		t.Fatalf("the field name is not capitalised any more: %v", body.Error.Details)
	}
}

func TestFailReasonKeepsTheCodeAndAddsTheCause(t *testing.T) {
	gin.SetMode(gin.TestMode)

	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodPost, "/", nil)

	response.FailReason(c, http.StatusConflict, response.CodeConflict,
		response.ReasonVersionConflict, "the note was changed by someone else")

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusConflict)
	}

	var body response.ErrorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal %s: %v", rec.Body, err)
	}

	// The nine codes are what existing clients branch on: a reason must not displace one.
	if body.Error.Code != response.CodeConflict {
		t.Fatalf("code = %q, want %q", body.Error.Code, response.CodeConflict)
	}

	if got := body.Error.Details[response.ReasonKey]; got != response.ReasonVersionConflict {
		t.Fatalf("reason = %q, want %q", got, response.ReasonVersionConflict)
	}

	if !c.IsAborted() {
		t.Fatal("the handler chain kept running")
	}
}

func TestInternalNamesItselfWithoutSayingWhy(t *testing.T) {
	gin.SetMode(gin.TestMode)

	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodGet, "/", nil)

	response.Internal(c)

	var body response.ErrorResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal %s: %v", rec.Body, err)
	}

	if got := body.Error.Details[response.ReasonKey]; got != response.ReasonInternal {
		t.Fatalf("reason = %q, want %q", got, response.ReasonInternal)
	}
}
