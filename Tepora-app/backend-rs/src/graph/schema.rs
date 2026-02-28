use serde::{Deserialize, Serialize};

/// Defines a node within a workflow JSON definition
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeDef {
    /// Unique identifier for the node instance in this graph (e.g., "chat", "search_1")
    pub id: String,
    /// The concrete Node implementation type (e.g., "ChatNode", "SearchNode")
    #[serde(rename = "type")]
    pub node_type: String,
    /// GUI specific metadata like X/Y coordinates
    #[serde(default)]
    pub metadata: serde_json::Value,
}

/// Defines an edge (transition) between two nodes
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgeDef {
    /// The source node ID
    pub from: String,
    /// The target node ID
    pub to: String,
    /// Optional condition string. If missing, it's a default/always edge.
    pub condition: Option<String>,
    /// GUI specific metadata
    #[serde(default)]
    pub metadata: serde_json::Value,
}

/// The root workflow definition loaded from a JSON file
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowDef {
    /// The name/id of the workflow
    pub name: String,
    /// The starting node ID
    pub entry_node: String,
    /// List of instances to place in the graph
    pub nodes: Vec<NodeDef>,
    /// List of directed edges connecting the nodes
    pub edges: Vec<EdgeDef>,
    /// Max recursion depth
    pub max_steps: Option<usize>,
    /// Max execution time in milliseconds
    pub execution_timeout_ms: Option<u64>,
}

/// The strict JSON Schema for WorkflowDef
pub const WORKFLOW_SCHEMA_JSON: &str = r#"{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "WorkflowDef",
  "type": "object",
  "required": ["name", "entry_node", "nodes", "edges"],
  "properties": {
    "name": { "type": "string" },
    "entry_node": { "type": "string" },
    "max_steps": { "type": "integer", "minimum": 1 },
    "execution_timeout_ms": { "type": "integer", "minimum": 1 },
    "nodes": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "type"],
        "properties": {
          "id": { "type": "string" },
          "type": { "type": "string" },
          "metadata": { "type": "object" }
        }
      }
    },
    "edges": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["from", "to"],
        "properties": {
          "from": { "type": "string" },
          "to": { "type": "string" },
          "condition": { "type": "string" },
          "metadata": { "type": "object" }
        }
      }
    }
  }
}"#;

/// Validates a parsed JSON value against the strict WorkflowDef JSON Schema.
/// Returns Ok(()) if valid, or a vector of error strings if invalid.
pub fn validate_workflow_json(value: &serde_json::Value) -> Result<(), Vec<String>> {
    let schema_json: serde_json::Value = serde_json::from_str(WORKFLOW_SCHEMA_JSON)
        .expect("Hardcoded WORKFLOW_SCHEMA_JSON is invalid");
    
    let compiled_schema = jsonschema::validator_for(&schema_json)
        .expect("Failed to compile WORKFLOW_SCHEMA_JSON");

    let result = compiled_schema.validate(value);
    match result {
        Ok(_) => Ok(()),
        Err(err) => {
            Err(vec![err.to_string()])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_valid_workflow_json() {
        let valid = json!({
            "name": "Test",
            "entry_node": "chat",
            "nodes": [
                { "id": "chat", "type": "ChatNode", "metadata": { "label": "Start" } }
            ],
            "edges": []
        });

        assert!(validate_workflow_json(&valid).is_ok());
    }

    #[test]
    fn test_invalid_workflow_json_missing_fields() {
        let invalid = json!({
            "name": "Missing Nodes and Edges",
            "entry_node": "chat"
        });

        let res = validate_workflow_json(&invalid);
        assert!(res.is_err());
        let errs = res.unwrap_err();
        assert!(errs.iter().any(|e| e.contains("\"nodes\" is a required property") || e.contains("is not valid")));
    }

    #[test]
    fn test_workflow_metadata_roundtrip() {
        let original_json = json!({
            "name": "RoundTripTest",
            "entry_node": "start",
            "nodes": [
                {
                    "id": "start",
                    "type": "RouterNode",
                    "metadata": {
                        "label": "Starting Point",
                        "x": 100,
                        "y": 200,
                        "custom_gui_color": "#ff0000"
                    }
                }
            ],
            "edges": [
                {
                    "from": "start",
                    "to": "end",
                    "metadata": {
                        "edge_type": "dashed",
                        "stroke_width": 2
                    }
                }
            ]
        });

        assert!(validate_workflow_json(&original_json).is_ok());

        let workflow: WorkflowDef = serde_json::from_value(original_json.clone())
            .expect("Should deserialize valid workflow correctly");

        let serialized_json = serde_json::to_value(&workflow)
            .expect("Should serialize back to JSON correctly");

        // Assert that the unknown metadata is structurally preserved
        assert_eq!(original_json["nodes"][0]["metadata"]["label"], "Starting Point");
        assert_eq!(serialized_json["nodes"][0]["metadata"]["label"], "Starting Point");
        assert_eq!(serialized_json["nodes"][0]["metadata"]["x"], 100);
        assert_eq!(serialized_json["edges"][0]["metadata"]["edge_type"], "dashed");
    }
}
