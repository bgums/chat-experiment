export function extractTextFromResponse(response) {
  if (!response) {
    return "";
  }

  if (response.output_text && typeof response.output_text === "string") {
    return response.output_text;
  }

  if (Array.isArray(response.output)) {
    return response.output
      .map((item) => {
        if (!item) return "";
        if (typeof item.text === "string") {
          return item.text;
        }
        if (Array.isArray(item.content)) {
          return item.content
            .map((part) => {
              if (!part) return "";
              if (typeof part.text === "string") {
                return part.text;
              }
              if (part.type === "output_text" && typeof part.output_text === "string") {
                return part.output_text;
              }
              if (part.type === "input_text" && typeof part.input_text === "string") {
                return part.input_text;
              }
              return "";
            })
            .join("");
        }
        return "";
      })
      .join("");
  }

  if (Array.isArray(response.data)) {
    return response.data
      .map((entry) => (typeof entry?.text === "string" ? entry.text : ""))
      .join("");
  }

  return "";
}
