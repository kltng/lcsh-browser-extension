import React from 'react';
import { Tooltip, Typography } from '@mui/material';
import { confidenceLevel, confidenceTooltip } from './pipelineText';

/**
 * SPEC-UI2 §6: "AI confidence: High/Medium/Low" for ONE AI selection, with a
 * keyboard-accessible tooltip giving the number. Nothing for manual or exact
 * choices, and nothing for a null or invalid value.
 * @param {{method:string, confidence:any}} props - The selection's method and confidence
 * @returns {JSX.Element|null}
 */
const ConfidenceBadge = ({ method, confidence }) => {
  const level = method === 'ai' ? confidenceLevel(confidence) : null;
  if (!level) return null;
  return (
    <Tooltip title={confidenceTooltip(confidence)} describeChild>
      <Typography
        component="span" variant="body2" tabIndex={0} data-confidence={confidence}
        sx={{ ml: 0.5, textDecoration: 'underline dotted', cursor: 'help' }}
      >
        AI confidence: {level}
      </Typography>
    </Tooltip>
  );
};

export default ConfidenceBadge;
