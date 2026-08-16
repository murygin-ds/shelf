package response_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"shelf/internal/api/response"

	"github.com/gin-gonic/gin"
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
