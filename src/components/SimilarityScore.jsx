import React from 'react';
import { Box, Typography, Tooltip, LinearProgress } from '@mui/material';
import { getSimilarityColor, getSimilarityLabel } from '../utils/similarityUtils';

/**
 * Component to display a similarity score with visual indicators
 * @param {Object} props - Component props
 * @param {number} props.score - Similarity score (0-100)
 * @param {string} props.label - Optional label to display
 * @param {boolean} props.showLabel - Whether to show the similarity label
 * @param {boolean} props.showTooltip - Whether to show a tooltip with details
 * @param {Object} props.sx - Additional styles
 * @returns {JSX.Element} - Rendered component
 */
const SimilarityScore = ({
    score,
    label,
    showLabel = true,
    showTooltip = true,
    sx = {}
}) => {
    const color = getSimilarityColor(score);
    const similarityLabel = getSimilarityLabel(score);

    const content = (
        <Box sx={{
            display: 'flex',
            flexDirection: 'column',
            width: '100%',
            ...sx
        }}>
            {label && (
                <Typography variant="caption" color="text.secondary" gutterBottom>
                    {label}
                </Typography>
            )}

            <Box sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                mb: 0.5
            }}>
                <Typography
                    variant="body2"
                    fontWeight="bold"
                    sx={{ color }}
                >
                    {score}%
                </Typography>

                {showLabel && (
                    <Typography variant="caption" sx={{ color }}>
                        {similarityLabel}
                    </Typography>
                )}
            </Box>

            <LinearProgress
                variant="determinate"
                value={score}
                sx={{
                    height: 8,
                    borderRadius: 4,
                    bgcolor: 'rgba(0, 0, 0, 0.1)',
                    '& .MuiLinearProgress-bar': {
                        bgcolor: color,
                        borderRadius: 4
                    }
                }}
            />
        </Box>
    );

    if (showTooltip) {
        return (
            <Tooltip
                title={`Similarity: ${score}% (${similarityLabel})`}
                arrow
                placement="top"
            >
                {content}
            </Tooltip>
        );
    }

    return content;
};

export default SimilarityScore; 