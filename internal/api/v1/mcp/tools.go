package mcp

import (
	"context"
	"fmt"
	"time"

	"shelf/internal/mcp"
	"shelf/internal/vault"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// nodeOut is a folder or a note as a tool reports it. Paths are what every other tool takes,
// so a model can move between them without holding an id.
type nodeOut struct {
	Path string   `json:"path"`
	Kind string   `json:"kind"`
	Name string   `json:"name"`
	Icon string   `json:"icon,omitempty"`
	Tags []string `json:"tags,omitempty"`
	// Locked marks a part of the vault sealed with a key the connector was not given. It is
	// listed rather than hidden, so a model can tell "not there" from "not for you".
	Locked bool `json:"locked,omitempty"`
	// ContentSeq is the version a write has to quote back. Notes only.
	ContentSeq int64     `json:"content_seq,omitempty"`
	UpdatedAt  time.Time `json:"updated_at"`
}

func nodeOf(n mcp.Node) nodeOut {
	return nodeOut{
		Path: n.Path, Kind: n.Kind, Name: n.Name, Icon: n.Icon, Tags: n.Tags,
		Locked: n.Locked, ContentSeq: n.ContentSeq, UpdatedAt: n.UpdatedAt,
	}
}

func nodesOf(nodes []mcp.Node) []nodeOut {
	out := make([]nodeOut, 0, len(nodes))
	for _, node := range nodes {
		out = append(out, nodeOf(node))
	}

	return out
}

type (
	listInput struct {
		Path string `json:"path,omitempty" jsonschema:"Folder to list from, as a slash path. Omit for the whole vault."`
	}
	listOutput struct {
		Nodes []nodeOut `json:"nodes"`
	}

	readInput struct {
		Path string `json:"path" jsonschema:"Path of the note, exactly as shelf_list_tree reports it."`
	}
	readOutput struct {
		Note nodeOut `json:"note"`
		Body string  `json:"body"`
	}

	searchInput struct {
		Query string `json:"query" jsonschema:"Text to look for in note titles and bodies."`
		Limit int    `json:"limit,omitempty" jsonschema:"Maximum results, 1 to 50. Defaults to 10."`
	}
	searchOutput struct {
		Hits []hitOut `json:"hits"`
	}
	hitOut struct {
		nodeOut
		Snippet string `json:"snippet"`
	}

	folderInput struct {
		Path string `json:"path" jsonschema:"Folder path to create. Missing parents are created too."`
	}
	folderOutput struct {
		Folder nodeOut `json:"folder"`
	}

	createInput struct {
		Path string `json:"path" jsonschema:"Path of the new note, including its name. Missing folders are created."`
		Body string `json:"body,omitempty" jsonschema:"Markdown body. Omit for an empty note."`
	}

	writeInput struct {
		Path string `json:"path" jsonschema:"Path of the note to replace."`
		Body string `json:"body" jsonschema:"The complete new body. This replaces the note, it does not merge."`
		//nolint:lll // the description is the contract a model reads.
		ExpectedContentSeq int64 `json:"expected_content_seq" jsonschema:"The content_seq you last read for this note. A mismatch is refused rather than merged: read the note again and reapply your change."`
	}

	appendInput struct {
		Path string `json:"path" jsonschema:"Path of the note to add to."`
		Text string `json:"text" jsonschema:"Markdown to add at the end. A newline is inserted if the note lacks one."`
	}

	writeOutput struct {
		Note nodeOut `json:"note"`
	}

	moveInput struct {
		Path   string `json:"path"   jsonschema:"Path of the note to move."`
		Folder string `json:"folder" jsonschema:"Destination folder. Empty moves the note to the vault root."`
	}

	trashInput struct {
		Path string `json:"path" jsonschema:"Path of the note to move to the trash. It is recoverable from there."`
	}
	trashOutput struct {
		Trashed string `json:"trashed"`
	}
)

const (
	defaultSearchLimit = 10
	maxSearchLimit     = 50
)

// register mounts the tools this connector's role allows.
//
// A viewer gets no writing tools at all rather than tools that refuse: a model shown a tool
// will try it, and a refusal it cannot avoid is worse than the tool not being there.
func (t *Transport) register(server *sdk.Server, connector *mcp.Connector) {
	t.readTools(server, connector)

	if connector.Role == vault.RoleEditor {
		t.writeTools(server, connector)
	}
}

func (t *Transport) readTools(server *sdk.Server, connector *mcp.Connector) {
	sdk.AddTool(server, &sdk.Tool{
		Name: "shelf_list_tree",
		Description: "List the folders and notes of the connected vault as slash paths. " +
			"Start here: every other tool takes a path this returns.",
	}, func(ctx context.Context, _ *sdk.CallToolRequest, in listInput) (*sdk.CallToolResult, listOutput, error) {
		workspace, err := t.open(ctx, connector)
		if err != nil {
			return nil, listOutput{}, t.logged("shelf_list_tree", connector, err)
		}

		nodes, err := workspace.Tree(ctx, in.Path)
		if err != nil {
			return nil, listOutput{}, t.logged("shelf_list_tree", connector, err)
		}

		return nil, listOutput{Nodes: nodesOf(nodes)}, nil
	})

	sdk.AddTool(server, &sdk.Tool{
		Name: "shelf_read_note",
		Description: "Read one note's body. The content_seq it returns is what shelf_write_note " +
			"has to quote back.",
	}, func(ctx context.Context, _ *sdk.CallToolRequest, in readInput) (*sdk.CallToolResult, readOutput, error) {
		workspace, err := t.open(ctx, connector)
		if err != nil {
			return nil, readOutput{}, t.logged("shelf_read_note", connector, err)
		}

		note, err := workspace.ReadNote(ctx, in.Path)
		if err != nil {
			return nil, readOutput{}, t.logged("shelf_read_note", connector, err)
		}

		return nil, readOutput{Note: nodeOf(note.Node), Body: note.Body}, nil
	})

	sdk.AddTool(server, &sdk.Tool{
		Name: "shelf_search_notes",
		Description: "Search note titles and bodies. Returns snippets; follow up with " +
			"shelf_read_note for the full text.",
	}, func(ctx context.Context, _ *sdk.CallToolRequest, in searchInput) (*sdk.CallToolResult, searchOutput, error) {
		workspace, err := t.open(ctx, connector)
		if err != nil {
			return nil, searchOutput{}, t.logged("shelf_search_notes", connector, err)
		}

		limit := in.Limit
		if limit <= 0 {
			limit = defaultSearchLimit
		}

		limit = min(limit, maxSearchLimit)

		hits, err := workspace.Search(ctx, in.Query, limit)
		if err != nil {
			return nil, searchOutput{}, t.logged("shelf_search_notes", connector, err)
		}

		out := searchOutput{Hits: make([]hitOut, 0, len(hits))}
		for _, hit := range hits {
			out.Hits = append(out.Hits, hitOut{nodeOut: nodeOf(hit.Node), Snippet: hit.Snippet})
		}

		return nil, out, nil
	})
}

func (t *Transport) writeTools(server *sdk.Server, connector *mcp.Connector) {
	sdk.AddTool(server, &sdk.Tool{
		Name:        "shelf_create_folder",
		Description: "Create a folder, and any folder above it that does not exist yet.",
	}, func(ctx context.Context, _ *sdk.CallToolRequest, in folderInput) (*sdk.CallToolResult, folderOutput, error) {
		workspace, err := t.open(ctx, connector)
		if err != nil {
			return nil, folderOutput{}, t.logged("shelf_create_folder", connector, err)
		}

		folder, err := workspace.CreateFolder(ctx, in.Path)
		if err != nil {
			return nil, folderOutput{}, t.logged("shelf_create_folder", connector, err)
		}

		return nil, folderOutput{Folder: nodeOf(*folder)}, nil
	})

	sdk.AddTool(server, &sdk.Tool{
		Name: "shelf_create_note",
		Description: fmt.Sprintf(
			"Create a note, with its folders if they are missing. Bodies are markdown, up to %d bytes.",
			mcp.MaxBodyBytes),
	}, func(ctx context.Context, _ *sdk.CallToolRequest, in createInput) (*sdk.CallToolResult, writeOutput, error) {
		workspace, err := t.open(ctx, connector)
		if err != nil {
			return nil, writeOutput{}, t.logged("shelf_create_note", connector, err)
		}

		note, err := workspace.CreateNote(ctx, in.Path, in.Body)
		if err != nil {
			return nil, writeOutput{}, t.logged("shelf_create_note", connector, err)
		}

		return nil, writeOutput{Note: nodeOf(note.Node)}, nil
	})

	sdk.AddTool(server, &sdk.Tool{
		Name: "shelf_write_note",
		Description: "Replace a note's body. Quote back the content_seq you read: if somebody " +
			"changed the note since, the write is refused rather than overwriting them.",
	}, func(ctx context.Context, _ *sdk.CallToolRequest, in writeInput) (*sdk.CallToolResult, writeOutput, error) {
		workspace, err := t.open(ctx, connector)
		if err != nil {
			return nil, writeOutput{}, t.logged("shelf_write_note", connector, err)
		}

		note, err := workspace.WriteNote(ctx, in.Path, in.Body, in.ExpectedContentSeq)
		if err != nil {
			return nil, writeOutput{}, t.logged("shelf_write_note", connector, err)
		}

		return nil, writeOutput{Note: nodeOf(note.Node)}, nil
	})

	sdk.AddTool(server, &sdk.Tool{
		Name:        "shelf_append_note",
		Description: "Add to the end of a note. Reads and writes in one step, so no version is needed.",
	}, func(ctx context.Context, _ *sdk.CallToolRequest, in appendInput) (*sdk.CallToolResult, writeOutput, error) {
		workspace, err := t.open(ctx, connector)
		if err != nil {
			return nil, writeOutput{}, t.logged("shelf_append_note", connector, err)
		}

		note, err := workspace.AppendNote(ctx, in.Path, in.Text)
		if err != nil {
			return nil, writeOutput{}, t.logged("shelf_append_note", connector, err)
		}

		return nil, writeOutput{Note: nodeOf(note.Node)}, nil
	})

	sdk.AddTool(server, &sdk.Tool{
		Name:        "shelf_move_note",
		Description: "Move a note to another folder, creating the folder if it is missing.",
	}, func(ctx context.Context, _ *sdk.CallToolRequest, in moveInput) (*sdk.CallToolResult, writeOutput, error) {
		workspace, err := t.open(ctx, connector)
		if err != nil {
			return nil, writeOutput{}, t.logged("shelf_move_note", connector, err)
		}

		note, err := workspace.MoveNote(ctx, in.Path, in.Folder)
		if err != nil {
			return nil, writeOutput{}, t.logged("shelf_move_note", connector, err)
		}

		return nil, writeOutput{Note: nodeOf(*note)}, nil
	})

	// Trash only. Purging destroys ciphertext nothing brings back, which is not a decision
	// to put behind a tool call.
	sdk.AddTool(server, &sdk.Tool{
		Name:        "shelf_trash_note",
		Description: "Move a note to the trash, where a person can restore it. Nothing here deletes for good.",
	}, func(ctx context.Context, _ *sdk.CallToolRequest, in trashInput) (*sdk.CallToolResult, trashOutput, error) {
		workspace, err := t.open(ctx, connector)
		if err != nil {
			return nil, trashOutput{}, t.logged("shelf_trash_note", connector, err)
		}

		if err := workspace.TrashNote(ctx, in.Path); err != nil {
			return nil, trashOutput{}, t.logged("shelf_trash_note", connector, err)
		}

		return nil, trashOutput{Trashed: in.Path}, nil
	})
}
