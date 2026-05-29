import React, { useState, useRef } from 'react';
import {
    Box,
    TextField,
    Button,
    Typography,
    Grid,
    Paper,
    Divider,
    Alert,
    CircularProgress,
    IconButton,
    Card,
    CardMedia,
    CardContent,
    CardActions
} from '@mui/material';
import { useAppContext } from '../context/AppContext';
import { generateLcshSuggestions, parseLcshSuggestions } from '../services/geminiService';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import DeleteIcon from '@mui/icons-material/Delete';
import ImageIcon from '@mui/icons-material/Image';

const BibliographicInfoForm = () => {
    const {
        bibliographicInfo,
        setBibliographicInfo,
        systemPromptRules,
        apiKey,
        setActiveStep,
        setInitialSuggestions,
        setIsLoading,
        isLoading,
        error,
        setError
    } = useAppContext();

    const [uploadedImages, setUploadedImages] = useState([]);
    const fileInputRef = useRef(null);

    // Handle form input changes
    const handleInputChange = (e) => {
        const { name, value } = e.target;
        setBibliographicInfo({
            ...bibliographicInfo,
            [name]: value
        });
    };

    // Handle file input change
    const handleFileChange = (e) => {
        const files = Array.from(e.target.files);

        // Filter for only image files (PNG and JPEG)
        const imageFiles = files.filter(file =>
            file.type === 'image/png' ||
            file.type === 'image/jpeg' ||
            file.type === 'image/jpg'
        );

        if (imageFiles.length !== files.length) {
            setError('Only PNG and JPEG images are allowed');
            return;
        }

        // Process each image file
        const newImages = imageFiles.map(file => ({
            file,
            preview: URL.createObjectURL(file),
            name: file.name,
            type: file.type,
            size: file.size
        }));

        setUploadedImages([...uploadedImages, ...newImages]);

        // Reset the file input
        e.target.value = null;
    };

    // Handle image delete
    const handleDeleteImage = (index) => {
        const newImages = [...uploadedImages];

        // Revoke the object URL to avoid memory leaks
        URL.revokeObjectURL(newImages[index].preview);

        newImages.splice(index, 1);
        setUploadedImages(newImages);
    };

    // Trigger file input click
    const handleUploadClick = () => {
        fileInputRef.current.click();
    };

    // Convert images to base64
    const convertImagesToBase64 = async () => {
        const base64Images = await Promise.all(
            uploadedImages.map(image =>
                new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve({
                        data: reader.result,
                        name: image.name,
                        type: image.type,
                        size: image.size
                    });
                    reader.onerror = reject;
                    reader.readAsDataURL(image.file);
                })
            )
        );

        return base64Images;
    };

    // Validate form
    const validateForm = () => {
        // At minimum, we need a title or at least one image
        if (!bibliographicInfo.title.trim() && uploadedImages.length === 0) {
            setError('Please provide a title or upload at least one image');
            return false;
        }

        // Clear any previous errors
        setError(null);
        return true;
    };

    // Handle form submission
    const handleSubmit = async (e) => {
        e.preventDefault();

        if (!validateForm()) {
            return;
        }

        try {
            setIsLoading(true);

            // Convert images to base64 if any
            let imageData = [];
            if (uploadedImages.length > 0) {
                imageData = await convertImagesToBase64();
            }

            // Add image data to bibliographic info
            const enhancedBibliographicInfo = {
                ...bibliographicInfo,
                images: imageData
            };
            setBibliographicInfo({
                ...bibliographicInfo,
                images: imageData.map(({ name, type, size }) => ({ name, type, size }))
            });

            // Generate LCSH suggestions using the Gemini API
            const response = await generateLcshSuggestions(
                apiKey,
                enhancedBibliographicInfo,
                systemPromptRules
            );

            // Parse the response
            const parsedSuggestions = parseLcshSuggestions(response);

            // Store the suggestions in the context
            setInitialSuggestions(parsedSuggestions);

            // Move to the next step
            setActiveStep(1);
        } catch (err) {
            setError(err.message || 'Failed to generate LCSH suggestions');
            console.error('Error generating LCSH suggestions:', err);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <Box component="form" onSubmit={handleSubmit} noValidate>
            <Typography variant="h6" gutterBottom>
                Enter Bibliographic Information
            </Typography>

            {error && (
                <Alert severity="error" sx={{ mb: 2 }}>
                    {error}
                </Alert>
            )}

            <Grid container spacing={3}>
                <Grid item xs={12}>
                    <TextField
                        required={uploadedImages.length === 0}
                        fullWidth
                        label="Title"
                        name="title"
                        value={bibliographicInfo.title}
                        onChange={handleInputChange}
                        variant="outlined"
                        helperText={uploadedImages.length === 0 ? "Required (or upload an image)" : "Optional if image is uploaded"}
                    />
                </Grid>

                <Grid item xs={12}>
                    <TextField
                        fullWidth
                        label="Author"
                        name="author"
                        value={bibliographicInfo.author}
                        onChange={handleInputChange}
                        variant="outlined"
                    />
                </Grid>

                <Grid item xs={12}>
                    <TextField
                        fullWidth
                        label="Abstract"
                        name="abstract"
                        value={bibliographicInfo.abstract}
                        onChange={handleInputChange}
                        variant="outlined"
                        multiline
                        rows={4}
                        helperText="A brief summary of the work"
                    />
                </Grid>

                <Grid item xs={12}>
                    <TextField
                        fullWidth
                        label="Table of Contents"
                        name="tableOfContents"
                        value={bibliographicInfo.tableOfContents}
                        onChange={handleInputChange}
                        variant="outlined"
                        multiline
                        rows={4}
                        helperText="List of chapters or sections"
                    />
                </Grid>

                <Grid item xs={12}>
                    <TextField
                        fullWidth
                        label="Additional Notes"
                        name="notes"
                        value={bibliographicInfo.notes}
                        onChange={handleInputChange}
                        variant="outlined"
                        multiline
                        rows={4}
                        helperText="Any other relevant information"
                    />
                </Grid>

                <Grid item xs={12}>
                    <Box sx={{ mb: 2 }}>
                        <Typography variant="subtitle1" gutterBottom>
                            Upload Images (PNG, JPEG)
                        </Typography>
                        <Typography variant="body2" color="text.secondary" gutterBottom>
                            You can upload images of book covers, title pages, or other bibliographic information.
                        </Typography>

                        <input
                            type="file"
                            accept="image/png, image/jpeg, image/jpg"
                            style={{ display: 'none' }}
                            ref={fileInputRef}
                            onChange={handleFileChange}
                            multiple
                        />

                        <Button
                            variant="outlined"
                            startIcon={<CloudUploadIcon />}
                            onClick={handleUploadClick}
                            sx={{ mb: 2 }}
                        >
                            Upload Images
                        </Button>
                    </Box>

                    {uploadedImages.length > 0 && (
                        <Grid container spacing={2}>
                            {uploadedImages.map((image, index) => (
                                <Grid item xs={12} sm={6} md={4} key={index}>
                                    <Card>
                                        <CardMedia
                                            component="img"
                                            height="140"
                                            image={image.preview}
                                            alt={image.name}
                                            sx={{ objectFit: 'contain', bgcolor: '#f5f5f5' }}
                                        />
                                        <CardContent sx={{ py: 1 }}>
                                            <Typography variant="body2" noWrap>
                                                {image.name}
                                            </Typography>
                                            <Typography variant="caption" color="text.secondary">
                                                {(image.size / 1024).toFixed(1)} KB
                                            </Typography>
                                        </CardContent>
                                        <CardActions sx={{ justifyContent: 'flex-end', pt: 0 }}>
                                            <IconButton
                                                size="small"
                                                color="error"
                                                onClick={() => handleDeleteImage(index)}
                                            >
                                                <DeleteIcon fontSize="small" />
                                            </IconButton>
                                        </CardActions>
                                    </Card>
                                </Grid>
                            ))}
                        </Grid>
                    )}
                </Grid>
            </Grid>

            <Box sx={{ mt: 3, display: 'flex', justifyContent: 'flex-end' }}>
                <Button
                    type="submit"
                    variant="contained"
                    color="primary"
                    size="large"
                    disabled={isLoading}
                >
                    {isLoading ? (
                        <>
                            <CircularProgress size={24} sx={{ mr: 1 }} />
                            Generating Suggestions...
                        </>
                    ) : (
                        'Generate LCSH Suggestions'
                    )}
                </Button>
            </Box>
        </Box>
    );
};

export default BibliographicInfoForm;
