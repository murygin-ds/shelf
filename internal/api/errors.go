package api

import (
	"net/http"
	"shelf/internal/api/response"

	"github.com/gin-gonic/gin"
)

func notFound(c *gin.Context) {
	response.Fail(c, http.StatusNotFound, response.CodeNotFound, "route not found")
}

func methodNotAllowed(c *gin.Context) {
	response.Fail(c, http.StatusMethodNotAllowed, response.CodeBadRequest, "method not allowed")
}
